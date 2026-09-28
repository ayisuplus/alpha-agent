import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCodeWorkspace } from "../src/runtime/workspace-import";
import { applyCodeChanges, reviewCodeApply } from "../src/runtime/workspace-apply";
import { runCodeCheck } from "../src/runtime/code-check";
import { acceptCodeChange } from "../src/runtime/code-acceptance";
import { finalizeProjectTurn, prepareProjectTurn } from "../src/runtime/project-state";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

test("Git import captures dirty and untracked files in a managed worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-git-import-"));
  let managed: string | undefined;
  const source = join(root, "source");
  try {
    await mkdir(source);
    await git(source, "init");
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await writeFile(join(source, "app.js"), "committed");
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "base");
    await writeFile(join(source, "app.js"), "dirty");
    await writeFile(join(source, "new.js"), "untracked");
    await writeFile(join(source, "ignored.txt"), "ignore me");
    await writeFile(join(source, ".env"), "credential");
    const ledger = await importCodeWorkspace({ sourcePath: source, productsRoot: join(root, "products"), dataRoot: join(root, "state"), objective: "Fix app" });
    managed = ledger.state.projectRoot;
    expect(ledger.state.taskType).toBe("code-change");
    expect(ledger.state.workspaceOrigin?.kind).toBe("git");
    expect(await readFile(join(managed, "app.js"), "utf8")).toBe("dirty");
    expect(await readFile(join(managed, "new.js"), "utf8")).toBe("untracked");
    expect(await Bun.file(join(managed, ".env")).exists()).toBe(false);
    expect(await Bun.file(join(managed, "ignored.txt")).exists()).toBe(false);
    expect(await readFile(join(source, "app.js"), "utf8")).toBe("dirty");
    expect(await gitOutput(managed, "status", "--porcelain")).toBe("");
    const turn = await prepareProjectTurn({ dataRoot: join(root, "state"), projectRoot: managed, ledger, runId: crypto.randomUUID() });
    await writeFile(join(managed, "app.js"), "fixed");
    const finished = await finalizeProjectTurn(turn, ledger);
    expect(finished.codeCommits).toHaveLength(1);
    expect(await gitOutput(managed, "status", "--porcelain")).toBe("");
    expect(await readFile(join(source, "app.js"), "utf8")).toBe("dirty");
  } finally {
    if (managed) await git(source, "worktree", "remove", "--force", managed);
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Git import honors ignore rules and leaves the source untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-copy-import-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await writeFile(join(source, "app.js"), "before");
    await writeFile(join(source, "ignored.txt"), "ignored");
    await writeFile(join(source, ".env.local"), "credential");
    const ledger = await importCodeWorkspace({ sourcePath: source, productsRoot: join(root, "products"), dataRoot: join(root, "state"), objective: "Fix copy" });
    expect(ledger.state.workspaceOrigin?.kind).toBe("copy");
    const manifestFile = ledger.state.workspaceOrigin!.snapshotFile!;
    expect(JSON.parse(await readFile(manifestFile, "utf8"))).toMatchObject({ format: "imports", version: 1 });
    // A legacy manifest without the tag must still load.
    const legacy = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
    delete legacy.format;
    delete legacy.version;
    await writeFile(manifestFile, JSON.stringify(legacy, null, 2));
    expect((await reviewCodeApply(ledger, join(root, "state"))).changes).toEqual([]);
    expect(await readFile(join(ledger.state.projectRoot, "app.js"), "utf8")).toBe("before");
    expect(await Bun.file(join(ledger.state.projectRoot, "ignored.txt")).exists()).toBe(false);
    expect(await Bun.file(join(ledger.state.projectRoot, ".env.local")).exists()).toBe(false);
    expect(await readFile(join(source, ".env.local"), "utf8")).toBe("credential");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("applying a reviewed code change stops on an independent source edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-apply-import-"));
  try {
    const source = join(root, "source");
    const dataRoot = join(root, "state");
    await mkdir(source);
    await writeFile(join(source, "app.js"), "original");
    const ledger = await importCodeWorkspace({ sourcePath: source, productsRoot: join(root, "products"), dataRoot, objective: "Fix copy" });
    await writeFile(join(ledger.state.projectRoot, "app.js"), "fixed");
    await ledger.refreshRevision();
    await ledger.recordEvidence({ criterionId: "change", kind: "asset", revision: ledger.state.revision!, passed: true, source: "review.json" });
    await ledger.recordEvidence({ criterionId: "check", kind: "test", revision: ledger.state.revision!, passed: true, source: "test.log" });
    await ledger.complete();
    expect((await reviewCodeApply(ledger, dataRoot)).changes).toMatchObject([{ path: "app.js", action: "modify", conflict: false }]);
    await writeFile(join(source, "app.js"), "user edit");
    expect((await reviewCodeApply(ledger, dataRoot)).conflicts).toEqual(["app.js"]);
    await expect(applyCodeChanges(ledger, dataRoot, ledger.state.revision!)).rejects.toThrow("Source changed since import");
    expect(await readFile(join(source, "app.js"), "utf8")).toBe("user edit");
    await writeFile(join(source, "app.js"), "original");
    expect(await applyCodeChanges(ledger, dataRoot, ledger.state.revision!)).toMatchObject([{ path: "app.js", action: "modify" }]);
    expect(await readFile(join(source, "app.js"), "utf8")).toBe("fixed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured checks run with a frozen script and archive their output", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-code-check-"));
  try {
    const source = join(root, "source");
    const dataRoot = join(root, "state");
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { test: "bun -e \"console.log('passed')\"" } }));
    const ledger = await importCodeWorkspace({ sourcePath: source, productsRoot: join(root, "products"), dataRoot, objective: "Check code" });
    const checks = ledger.state.workspaceOrigin?.checks ?? [];
    expect(checks).toEqual([{ name: "test", command: "bun -e \"console.log('passed')\"" }]);
    const result = await runCodeCheck(ledger.state.projectRoot, dataRoot, ledger.state.id, "test", checks);
    expect(result.passed).toBe(true);
    expect(await readFile(result.logPath, "utf8")).toContain("cwd=");
    await writeFile(join(ledger.state.projectRoot, "package.json"), JSON.stringify({ scripts: { test: "bun -e \"console.log('changed')\"" } }));
    await expect(runCodeCheck(ledger.state.projectRoot, dataRoot, ledger.state.id, "test", checks)).rejects.toThrow("requires workbench approval");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared code acceptance requires review and current check evidence before completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-code-acceptance-"));
  try {
    const source = join(root, "source");
    const dataRoot = join(root, "state");
    await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { test: "bun -e \"console.log('passed')\"" } }));
    await writeFile(join(source, "app.js"), "before");
    const ledger = await importCodeWorkspace({ sourcePath: source, productsRoot: join(root, "products"), dataRoot, objective: "Fix app" });
    await ledger.enableDevelopmentWorkflow();
    await writeFile(join(ledger.state.projectRoot, "app.js"), "after");
    await ledger.refreshRevision();
    expect(await acceptCodeChange({ ledger, dataRoot, runId: "first" })).toBe(false);
    expect(ledger.completionGaps()).toEqual(["development-review"]);
    await ledger.recordDevelopmentReview({ verdict: "pass", findings: [], instanceId: "review-1" });
    expect(await acceptCodeChange({ ledger, dataRoot, runId: "second", complete: false })).toBe(true);
    expect(ledger.state.status).toBe("active");
    await ledger.complete();
    expect(ledger.state.status).toBe("complete");
    expect(await readFile(join(source, "app.js"), "utf8")).toBe("before");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git import never executes repository-configured fsmonitor commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-import-fsmonitor-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await git(source, "init");
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await writeFile(join(source, "app.js"), "committed");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "base");
    const marker = join(root, "fsmonitor-ran");
    const probe = join(root, "fsmonitor-probe.sh");
    await writeFile(probe, `#!/bin/sh\ntouch "${marker.split("\\").join("/")}"\nexit 0\n`);
    await chmod(probe, 0o755);
    await git(source, "config", "core.fsmonitor", probe.split("\\").join("/"));
    const ledger = await importCodeWorkspace({ sourcePath: source, productsRoot: join(root, "products"), dataRoot: join(root, "state"), objective: "Fix app" });
    expect(ledger.state.workspaceOrigin?.kind).toBe("git");
    expect(await readFile(marker, "utf8").then(() => true, () => false)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
