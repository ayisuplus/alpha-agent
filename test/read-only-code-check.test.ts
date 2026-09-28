import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadOnlyCodeCheckTool, resolveCheckName, verificationSlotsRoot } from "../src/runtime/code-check";

async function project(root: string, name: string): Promise<{ projectRoot: string; command: string }> {
  const projectRoot = join(root, name);
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, "entry.txt"), "original");
  const command = "bun -e \"require('node:fs').writeFileSync('entry.txt','changed')\"";
  await writeFile(join(projectRoot, "package.json"), JSON.stringify({ scripts: { check: command } }));
  return { projectRoot, command };
}

test("read-only check preserves agent source and fails closed when sandbox verification is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-readonly-check-"));
  try {
    const { projectRoot, command } = await project(root, "project");
    const result = await createReadOnlyCodeCheckTool(projectRoot, join(root, "data"), crypto.randomUUID(), [{ name: "check", command }]).execute("check", { script: "check" }, undefined, undefined as never);
    expect(result.isError).toBe(true);
    expect(await readFile(join(projectRoot, "entry.txt"), "utf8")).toBe("original");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 70_000);

test("checks reuse a few fixed slots, which are emptied and unlocked afterwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-readonly-slots-"));
  try {
    const projects = await Promise.all(Array.from({ length: 5 }, (_, index) => project(root, `project-${index}`)));
    await Promise.all(projects.map(item => createReadOnlyCodeCheckTool(item.projectRoot, join(root, "data"), crypto.randomUUID(), [{ name: "check", command: item.command }]).execute("check", { script: "check" }, undefined, undefined as never)));
    const slots = verificationSlotsRoot(join(root, "data"));
    const entries = (await readdir(slots)).sort();
    expect(entries.filter(name => name.endsWith(".lock"))).toEqual([]);
    expect(entries.length).toBeLessThanOrEqual(3);
    for (const slot of entries) expect(await readdir(join(slots, slot))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 70_000);

test("a check can be named by its script or by the command that runs it, never by an arbitrary command", () => {
  const allowed = [{ name: "test", command: "bun test test" }, { name: "lint", command: "eslint ." }];
  expect(resolveCheckName("test", allowed)).toBe("test");
  expect(resolveCheckName("bun run test", allowed)).toBe("test");
  expect(resolveCheckName("npm test", allowed)).toBe("test");
  expect(resolveCheckName("bun test test", allowed)).toBe("test");
  expect(resolveCheckName(" eslint . ", allowed)).toBe("lint");
  expect(resolveCheckName("bun --version", allowed)).toBeNull();
  expect(resolveCheckName("bun run build", allowed)).toBeNull();
  expect(resolveCheckName("rm -rf . && bun test", allowed)).toBeNull();
});

test("when the sandbox is unavailable, the check says to stop retrying and review from source", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-readonly-unavailable-"));
  try {
    const { projectRoot, command } = await project(root, "project");
    const tool = createReadOnlyCodeCheckTool(projectRoot, join(root, "data"), crypto.randomUUID(), [{ name: "check", command }]);
    const text = (result: Awaited<ReturnType<typeof tool.execute>>) => result.content.map(part => part.type === "text" ? part.text : "").join("");
    const first = await tool.execute("check", { script: "check" }, undefined, undefined as never);
    expect(first.isError).toBe(true);
    expect(text(first)).toContain("Do not call alpha_check again");
    const started = performance.now();
    const second = await tool.execute("check", { script: "check" }, undefined, undefined as never);
    expect(text(second)).toBe(text(first));
    expect(performance.now() - started).toBeLessThan(50);
  } finally { await rm(root, { recursive: true, force: true }); }
});
