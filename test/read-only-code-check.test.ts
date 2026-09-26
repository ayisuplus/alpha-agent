import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadOnlyCodeCheckTool } from "../src/runtime/code-check";

test("read-only check preserves agent source and fails closed when sandbox verification is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-readonly-check-"));
  try {
    const projectRoot = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "entry.txt"), "original");
    const command = "bun -e \"require('node:fs').writeFileSync('entry.txt','changed')\"";
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ scripts: { check: command } }));
    const result = await createReadOnlyCodeCheckTool(projectRoot, dataRoot, crypto.randomUUID(), [{ name: "check", command }]).execute("check", { script: "check" }, undefined, undefined as never);
    expect(result.isError).toBe(true);
    expect(await readFile(join(projectRoot, "entry.txt"), "utf8")).toBe("original");
    expect(await readdir(join(dataRoot, "verification-copies"))).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
