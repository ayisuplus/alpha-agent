import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWritablePaths, finalizeProjectTurn, prepareProjectTurn, readProjectMemory, readProjectMemorySnapshot, recoverProjectTurn } from "../src/runtime/project-state";
import { ProjectStore } from "../src/runtime/projects";
import { TaskLedger } from "../src/runtime/task-ledger";

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(err || out);
  return out.trim();
}

test("new project gets a safe baseline, a code checkpoint, and independently versioned state", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-state-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "app.ts"), "export const value = 1;\n");
    await writeFile(join(work, ".env"), "secret=value\n");
    await mkdir(join(work, "node_modules"));
    await writeFile(join(work, "node_modules", "package.js"), "dependency\n");
    await mkdir(join(work, "dist"));
    await writeFile(join(work, "dist", "bundle.js"), "build\n");
    await writeFile(join(work, ".gitignore"), "ignored.txt\n");
    await writeFile(join(work, "ignored.txt"), "ignored\n");
    const ledger = await TaskLedger.create(data, { objective: "Change app", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    const journalFile = join(data, "project-turns", `${turn.runId}.json`);
    expect(JSON.parse(await readFile(journalFile, "utf8"))).toMatchObject({ format: "project-turns", version: 1 });
    expect(ledger.state.checkpointStatus).toBe("pending");
    expect(await git(work, "show", "HEAD:app.ts")).toContain("value = 1");
    expect(await git(work, "ls-files", ".env")).toBe("");
    expect(await git(work, "ls-files", "node_modules", "dist", "ignored.txt")).toBe("");
    await writeFile(join(work, "app.ts"), "export const value = 2;\n");
    await ledger.refreshRevision();
    // A legacy journal without the tag must still load, and finalization re-tags it on save.
    const legacy = JSON.parse(await readFile(journalFile, "utf8")) as Record<string, unknown>;
    delete legacy.format;
    delete legacy.version;
    await writeFile(journalFile, JSON.stringify(legacy, null, 2));
    const finished = await finalizeProjectTurn(turn, ledger);
    expect(finished.codeCommits).toHaveLength(1);
    expect(finished.memoryCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.parse(await readFile(journalFile, "utf8"))).toMatchObject({ format: "project-turns", version: 1 });
    expect(ledger.state.checkpointStatus).toBe("committed");
    expect(await git(work, "show", "HEAD:app.ts")).toContain("value = 2");
    expect(await readProjectMemory(data, work, ledger)).toContain(ledger.state.id);
    expect((await finalizeProjectTurn(turn, ledger)).memoryCommit).toBe(finished.memoryCommit);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic commit preserves unrelated dirty files and rejects edits to a dirty file", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-dirty-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await git(work, "init", "-b", "main");
    await writeFile(join(work, "user.txt"), "base\n");
    await writeFile(join(work, "agent.txt"), "base\n");
    await git(work, "add", "user.txt", "agent.txt");
    await git(work, "-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "base");
    await writeFile(join(work, "user.txt"), "user changes\n");
    const ledger = await TaskLedger.create(data, { objective: "Edit agent file", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "agent.txt"), "alpha changes\n");
    await ledger.refreshRevision();
    await finalizeProjectTurn(turn, ledger);
    expect(await git(work, "show", "HEAD:agent.txt")).toBe("alpha changes");
    expect(await git(work, "show", "HEAD:user.txt")).toBe("base");
    expect(await readFile(join(work, "user.txt"), "utf8")).toBe("user changes\n");
    const second = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "user.txt"), "mixed changes\n");
    await expect(finalizeProjectTurn(second, ledger)).rejects.toThrow("pre-existing changes");
    const third = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "user.txt"), "base\n");
    await expect(finalizeProjectTurn(third, ledger)).rejects.toThrow("user.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all tasks in one project share one bounded memory file", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-memory-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "file.txt"), "old\n");
    const first = await TaskLedger.create(data, { objective: "First", projectRoot: work, criteria: [], taskType: "general" });
    const one = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger: first, runId: crypto.randomUUID() });
    await writeFile(join(work, "file.txt"), "new\n");
    const firstFinished = await finalizeProjectTurn(one, first);
    const second = await TaskLedger.create(data, { objective: "Second", projectRoot: work, criteria: [], taskType: "general" });
    const two = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger: second, runId: crypto.randomUUID() });
    expect(await readProjectMemory(data, work, second)).toContain("First");
    const finished = await finalizeProjectTurn(two, second);
    expect(await readProjectMemory(data, work, second)).toContain("Second");
    expect(await readProjectMemory(data, work, second)).toContain(firstFinished.codeCommits[0]!.commit);
    expect(finished.memoryCommit).not.toBe(one.memoryCommit);
    expect((await readProjectMemorySnapshot(data, work, first)).commit).toBe(finished.memoryCommit ?? null);
    expect([...(await readProjectMemory(data, work, second))].length).toBeLessThanOrEqual(4_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two mounted directories get separate code commits and one project memory commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-mounts-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const data = join(root, ".alpha");
    await Promise.all([mkdir(first), mkdir(second)]);
    await writeFile(join(first, "a.txt"), "a\n");
    await writeFile(join(second, "b.txt"), "b\n");
    const ledger = await TaskLedger.create(data, { objective: "Update two roots", projectRoot: first, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: first, roots: [first, second], ledger, runId: crypto.randomUUID() });
    await writeFile(join(first, "a.txt"), "new a\n");
    await writeFile(join(second, "b.txt"), "new b\n");
    await ledger.refreshRevision();
    const result = await finalizeProjectTurn(turn, ledger);
    expect(result.codeCommits).toHaveLength(2);
    expect(await git(first, "show", "HEAD:a.txt")).toBe("new a");
    expect(await git(second, "show", "HEAD:b.txt")).toBe("new b");
    expect(await readProjectMemory(data, first, ledger)).toContain("项目提交：");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart recognizes a code commit made before its journal update", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-recover-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "app.txt"), "old\n");
    const ledger = await TaskLedger.create(data, { objective: "Recover", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "app.txt"), "new\n");
    await ledger.refreshRevision();
    await git(work, "add", "app.txt");
    await git(work, "-c", "user.name=Alpha Agent", "-c", "user.email=alpha@local.invalid", "commit", "-m", `alpha checkpoint\n\nAlpha-Run-Id: ${turn.runId}`);
    const head = await git(work, "rev-parse", "HEAD");
    const finished = await recoverProjectTurn(turn, ledger);
    expect(finished.codeCommits[0]?.commit).toBe(head);
    expect(await git(work, "rev-list", "--count", "HEAD")).toBe("2");
    expect(finished.memoryCommit).toMatch(/^[0-9a-f]{40}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["journaled", "not journaled"] as const)("recovery rejects edits after a %s code commit", async mode => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-postcommit-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "app.txt"), "old\n");
    const ledger = await TaskLedger.create(data, { objective: "Recover committed work", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "app.txt"), "committed\n");
    await git(work, "add", "app.txt");
    await git(work, "-c", "user.name=Alpha Agent", "-c", "user.email=alpha@local.invalid", "commit", "-m", `alpha checkpoint\n\nAlpha-Run-Id: ${turn.runId}`);
    const head = await git(work, "rev-parse", "HEAD");
    if (mode === "journaled") {
      turn.codeCommits.push({ root: work, commit: head });
      turn.status = "code-committed";
      await writeFile(join(data, "project-turns", `${turn.runId}.json`), JSON.stringify(turn));
    }
    await writeFile(join(work, "app.txt"), "later edit\n");
    await expect(recoverProjectTurn(turn, ledger)).rejects.toThrow("Uncommitted project changes");
    expect(await git(work, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(work, "app.txt"), "utf8")).toBe("later edit\n");
    expect(ledger.state.checkpointStatus).toBe("pending");
    expect(await readProjectMemory(data, work, ledger)).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["new head", "changed user file"] as const)("recovery rejects a %s after the code commit", async change => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-recovery-drift-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "app.txt"), "old\n");
    await writeFile(join(work, "user.txt"), "base\n");
    const ledger = await TaskLedger.create(data, { objective: "Recover after commit", projectRoot: work, criteria: [], taskType: "general" });
    await finalizeProjectTurn(await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() }), ledger);
    await writeFile(join(work, "user.txt"), "user's prior edit\n");
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "app.txt"), "alpha edit\n");
    await git(work, "add", "app.txt");
    await git(work, "-c", "user.name=Alpha Agent", "-c", "user.email=alpha@local.invalid", "commit", "-m", `alpha checkpoint\n\nAlpha-Run-Id: ${turn.runId}`);
    const checkpoint = await git(work, "rev-parse", "HEAD");
    turn.codeCommits.push({ root: work, commit: checkpoint });
    turn.status = "code-committed";
    await writeFile(join(data, "project-turns", `${turn.runId}.json`), JSON.stringify(turn));
    if (change === "new head") {
      await writeFile(join(work, "later.txt"), "later commit\n");
      await git(work, "add", "later.txt");
      await git(work, "-c", "user.name=Other", "-c", "user.email=other@local.invalid", "commit", "-m", "later commit");
    } else await writeFile(join(work, "user.txt"), "changed after checkpoint\n");
    await expect(recoverProjectTurn(turn, ledger)).rejects.toThrow(change === "new head" ? "Git HEAD changed" : "pre-existing changes");
    expect(ledger.state.checkpointStatus).toBe("pending");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory refuses to drop an oversized user requirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-limit-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    const ledger = await TaskLedger.create(data, { objective: "Preserve user requirement", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await ledger.recordGuidance("保留".repeat(2_100));
    await expect(finalizeProjectTurn(turn, ledger)).rejects.toThrow("memory.md limit");
    expect(await readProjectMemory(data, work, ledger)).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a project without mounts prepares its generated workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-empty-mounts-"));
  try {
    const work = join(root, "products", "project-test");
    const data = join(root, ".alpha");
    await mkdir(work, { recursive: true });
    await mkdir(data);
    const project = await new ProjectStore(data).create("Empty project");
    const ledger = await TaskLedger.create(data, { objective: "Start work", projectRoot: work, projectId: project.id, projectVersion: project.version, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    expect(turn.repos).toHaveLength(1);
    expect(turn.repos[0]?.root).toBe(work);
    await finalizeProjectTurn(turn, ledger);
    expect(await readProjectMemory(data, work, ledger)).toContain("Start work");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("checkpoint preserves the user's staged file", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-index-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await git(work, "init", "-b", "main");
    await writeFile(join(work, "user.txt"), "base\n");
    await writeFile(join(work, "agent.txt"), "base\n");
    await git(work, "add", "user.txt", "agent.txt");
    await git(work, "-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "base");
    await writeFile(join(work, "user.txt"), "staged by user\n");
    await git(work, "add", "user.txt");
    const ledger = await TaskLedger.create(data, { objective: "Edit agent file", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "agent.txt"), "changed by Alpha\n");
    await finalizeProjectTurn(turn, ledger);
    expect(await git(work, "show", "HEAD:user.txt")).toBe("base");
    expect(await git(work, "show", "HEAD:agent.txt")).toBe("changed by Alpha");
    expect(await git(work, "diff", "--cached", "--name-only")).toBe("user.txt");
    const next = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await git(work, "reset", "--", "user.txt");
    await expect(finalizeProjectTurn(next, ledger)).rejects.toThrow("user.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("renamed source file is committed without adding unrelated paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-rename-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "old.txt"), "data\n");
    const ledger = await TaskLedger.create(data, { objective: "Rename source", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await git(work, "mv", "old.txt", "new.txt");
    await finalizeProjectTurn(turn, ledger);
    expect(await git(work, "ls-files")).toBe("new.txt");
    expect(await git(work, "status", "--porcelain")).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two scopes in one authorized repository produce one code commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-one-repo-"));
  try {
    const work = join(root, "work");
    const sub = join(work, "sub");
    const data = join(root, ".alpha");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "file.txt"), "old\n");
    const ledger = await TaskLedger.create(data, { objective: "Change nested file", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, roots: [work, sub], ledger, runId: crypto.randomUUID() });
    expect(turn.repos).toHaveLength(1);
    await writeFile(join(sub, "file.txt"), "new\n");
    const finished = await finalizeProjectTurn(turn, ledger);
    expect(finished.codeCommits).toHaveLength(1);
    expect(await git(work, "show", "HEAD:sub/file.txt")).toBe("new");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a mount below the Git root cannot initialize or commit outside authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-outside-git-"));
  try {
    const work = join(root, "work");
    const sub = join(work, "sub");
    const data = join(root, ".alpha");
    await mkdir(sub, { recursive: true });
    await git(work, "init", "-b", "main");
    const ledger = await TaskLedger.create(data, { objective: "Inspect nested mount", projectRoot: sub, criteria: [], taskType: "general" });
    await expect(prepareProjectTurn({ dataRoot: data, projectRoot: sub, ledger, runId: crypto.randomUUID() })).rejects.toThrow("needs an existing commit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a mounted subdirectory commits only its scope in an existing parent repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-scoped-git-"));
  try {
    const work = join(root, "work");
    const sub = join(work, "sub");
    const data = join(root, ".alpha");
    await mkdir(sub, { recursive: true });
    await git(work, "init", "-b", "main");
    await writeFile(join(work, "outside.txt"), "outside base\n");
    await writeFile(join(sub, "inside.txt"), "inside base\n");
    await git(work, "add", "outside.txt", "sub/inside.txt");
    await git(work, "-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "base");
    await writeFile(join(work, "outside.txt"), "outside user edit\n");
    await git(work, "add", "outside.txt");
    const ledger = await TaskLedger.create(data, { objective: "Change mounted notes", projectRoot: sub, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: sub, ledger, runId: crypto.randomUUID() });
    expect(turn.repos[0]?.scopes).toEqual(["sub"]);
    expect(() => assertWritablePaths(turn, [join(work, "outside.txt")])).toThrow("outside the prepared repositories");
    await writeFile(join(sub, "inside.txt"), "inside Alpha edit\n");
    await ledger.refreshRevision();
    const result = await finalizeProjectTurn(turn, ledger);
    expect(result.codeCommits).toHaveLength(1);
    expect(await git(work, "show", "HEAD:sub/inside.txt")).toBe("inside Alpha edit");
    expect(await git(work, "show", "HEAD:outside.txt")).toBe("outside base");
    expect(await git(work, "diff", "--cached", "--name-only")).toBe("outside.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a read-only turn does not claim an unrelated filesystem edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-unattributed-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "file.txt"), "old\n");
    const ledger = await TaskLedger.create(data, { objective: "Answer a question", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await writeFile(join(work, "file.txt"), "external edit\n");
    await expect(finalizeProjectTurn(turn, ledger, false)).rejects.toThrow("no writing tool");
    expect(await git(work, "show", "HEAD:file.txt")).toBe("old");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery batches index reads for large dirty projects and accepts legacy snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-recovery-index-"));
  const spawn = spyOn(Bun, "spawn");
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    const staged = "修改 状态.txt";
    await mkdir(work);
    await writeFile(join(work, staged), "base\n");
    const ledger = await TaskLedger.create(data, { objective: "Recover existing changes", projectRoot: work, criteria: [], taskType: "general" });
    await finalizeProjectTurn(await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() }), ledger);
    const head = await git(work, "rev-parse", "HEAD");
    await writeFile(join(work, staged), "staged by user\n");
    await git(work, "add", "--", staged);
    const legacy = await git(work, "ls-files", "-s", "--", staged);
    await Promise.all(Array.from({ length: 128 }, (_, i) => writeFile(join(work, `existing-${i}.txt`), "user changes\n")));
    spawn.mockClear();
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    turn.repos[0]!.index[staged] = legacy;
    await writeFile(join(data, "project-turns", `${turn.runId}.json`), JSON.stringify(turn));
    const finished = await recoverProjectTurn(turn, ledger);
    expect(finished.status).toBe("finished");
    expect(finished.codeCommits).toHaveLength(0);
    const indexReads = spawn.mock.calls.filter(([command]) => Array.isArray(command) && command.includes("ls-files") && command.includes("-s"));
    expect(indexReads.length).toBeLessThanOrEqual(2);
    expect(await git(work, "rev-parse", "HEAD")).toBe(head);
    expect(await git(work, "ls-files", "-s", "--", staged)).toBe(legacy);
    expect(await readFile(join(work, "existing-127.txt"), "utf8")).toBe("user changes\n");
  } finally {
    spawn.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test.each(["prepared", "code-committed"] as const)("recovery never commits new changes from a %s journal", async status => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-recovery-uncommitted-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "app.txt"), "base\n");
    const ledger = await TaskLedger.create(data, { objective: "Recover without claiming edits", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    turn.status = status;
    await writeFile(join(data, "project-turns", `${turn.runId}.json`), JSON.stringify(turn));
    const head = await git(work, "rev-parse", "HEAD");
    await writeFile(join(work, "app.txt"), "external change after interruption\n");
    await expect(recoverProjectTurn(turn, ledger)).rejects.toThrow(/Uncommitted project changes|no writing tool/);
    expect(await git(work, "rev-parse", "HEAD")).toBe(head);
    expect(await git(work, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(join(work, "app.txt"), "utf8")).toBe("external change after interruption\n");
    expect(ledger.state.checkpointStatus).toBe("pending");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separate imported workspaces use the original path for one shared memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-import-memory-"));
  try {
    const source = join(root, "source");
    const firstWork = join(root, "products", "import-one");
    const secondWork = join(root, "products", "import-two");
    const data = join(root, ".alpha");
    await Promise.all([mkdir(source), mkdir(firstWork, { recursive: true }), mkdir(secondWork, { recursive: true })]);
    const origin = { kind: "copy" as const, sourcePath: source };
    const first = await TaskLedger.create(data, { objective: "First import", projectRoot: firstWork, workspaceOrigin: origin, criteria: [], taskType: "general" });
    await finalizeProjectTurn(await prepareProjectTurn({ dataRoot: data, projectRoot: firstWork, ledger: first, runId: crypto.randomUUID() }), first);
    const second = await TaskLedger.create(data, { objective: "Second import", projectRoot: secondWork, workspaceOrigin: origin, criteria: [], taskType: "general" });
    expect(await readProjectMemory(data, secondWork, second)).toContain("First import");
    const result = await finalizeProjectTurn(await prepareProjectTurn({ dataRoot: data, projectRoot: secondWork, ledger: second, runId: crypto.randomUUID() }), second);
    expect((await readProjectMemorySnapshot(data, firstWork, first)).commit).toBe(result.memoryCommit ?? null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed or cancelled task still commits its recorded state", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-stopped-memory-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    const ledger = await TaskLedger.create(data, { objective: "Attempt work", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await ledger.recordFailure("Verification failed");
    await ledger.stop("error");
    const finished = await finalizeProjectTurn(turn, ledger, false);
    expect(finished.codeCommits).toHaveLength(0);
    expect(await readProjectMemory(data, work, ledger)).toContain("Verification failed");
    expect(await readProjectMemory(data, work, ledger)).toContain("stopped");
    expect(ledger.state.status).toBe("stopped");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a deleted tracked file is included in the turn's commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-project-delete-"));
  try {
    const work = join(root, "work");
    const data = join(root, ".alpha");
    await mkdir(work);
    await writeFile(join(work, "remove.txt"), "old\n");
    const ledger = await TaskLedger.create(data, { objective: "Remove obsolete file", projectRoot: work, criteria: [], taskType: "general" });
    const turn = await prepareProjectTurn({ dataRoot: data, projectRoot: work, ledger, runId: crypto.randomUUID() });
    await rm(join(work, "remove.txt"));
    await finalizeProjectTurn(turn, ledger);
    expect(await git(work, "ls-files")).toBe("");
    expect(await git(work, "status", "--porcelain")).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
});
