import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredChecks, runCodeCheck } from "../src/runtime/code-check";
import { createDirectFileTools } from "../src/runtime/direct-file-tools";
import { ProjectStore } from "../src/runtime/projects";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(stderr);
  return stdout;
}

test("a dirty Git project is edited and checked in place", async () => {
  const data = await mkdtemp(join(tmpdir(), "alpha-direct-git-data-"));
  const root = await mkdtemp(join(tmpdir(), "alpha-direct-git-root-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Alpha Test");
    await git(root, "config", "user.email", "alpha@example.test");
    await writeFile(join(root, "main.txt"), "before\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { check: "bun test test/main.test.ts" } }));
    await mkdir(join(root, "test"));
    await writeFile(join(root, "test", "main.test.ts"), 'import {test,expect} from "bun:test"; test("direct", async()=>expect(await Bun.file("main.txt").text()).toContain("after"));\n');
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "base");
    await writeFile(join(root, "main.txt"), "before\nuser-dirty\n");
    const projects = new ProjectStore(data);
    const project = await projects.create("Dirty Git");
    const mounted = await projects.mount(project.id, root);
    const tools = await createDirectFileTools({ taskId: "dirty-git", projectId: project.id, projectVersion: mounted.version, projectRoot: root, dataRoot: data, mode: "full", onNeedsInput: async () => {} });
    const read = tools.find(item => item.name === "read")!;
    const edit = tools.find(item => item.name === "edit")!;
    const shown = await read.execute("read", { path: "main.txt" }, undefined, {} as never, new AbortController().signal);
    const header = shown.content[0]?.type === "text" ? shown.content[0].text.match(/\[[^\]]+#[0-9a-f]{4}\]/i)?.[0] : undefined;
    expect(header).toBeDefined();
    const changed = await edit.execute("edit", { input: `*** Begin Patch\n${header}\nPUT >2:\n+after\n*** End Patch` }, undefined, {} as never, new AbortController().signal);
    expect(changed.isError).toBe(false);
    const content = await readFile(join(root, "main.txt"), "utf8");
    expect(content).toContain("user-dirty");
    expect(content).toContain("after");
    const checks = await configuredChecks(root);
    const result = await runCodeCheck(root, data, "dirty-git", "check", checks, undefined, { mode: "full", roots: [root] });
    expect(result.passed).toBe(true);
    expect(await git(root, "status", "--short")).toContain("M main.txt");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await rm(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("a non-Git project is edited directly without creating a managed copy", async () => {
  const data = await mkdtemp(join(tmpdir(), "alpha-direct-nongit-data-"));
  const root = await mkdtemp(join(tmpdir(), "alpha-direct-nongit-root-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { check: "bun test test/main.test.ts" } }));
    await mkdir(join(root, "test"));
    await writeFile(join(root, "test", "main.test.ts"), 'import {test,expect} from "bun:test"; test("direct", async()=>expect(await Bun.file("new.txt").text()).toContain("direct"));\n');
    const projects = new ProjectStore(data);
    const project = await projects.create("Plain folder");
    const mounted = await projects.mount(project.id, root);
    const tools = await createDirectFileTools({ taskId: "plain-folder", projectId: project.id, projectVersion: mounted.version, projectRoot: root, dataRoot: data, mode: "full", onNeedsInput: async () => {} });
    const write = tools.find(item => item.name === "write")!;
    const changed = await write.execute("write", { path: "new.txt", content: "direct\n" }, undefined, {} as never, new AbortController().signal);
    expect(changed.isError).toBe(false);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("direct\n");
    const checks = await configuredChecks(root);
    const result = await runCodeCheck(root, data, "plain-folder", "check", checks, undefined, { mode: "full", roots: [root] });
    expect(result.passed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await rm(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
