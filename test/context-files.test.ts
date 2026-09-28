import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectContextFiles } from "../src/runtime/context-files";

test("only the workspace root's convention files are read, verbatim and bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-context-"));
  try {
    const project = join(root, "project");
    await mkdir(join(project, ".github"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "parent rules must not leak");
    await writeFile(join(root, "secret.txt"), "token-123");
    await writeFile(join(project, "AGENTS.md"), "Use pnpm.\n@../secret.txt");
    await writeFile(join(project, ".github", "copilot-instructions.md"), "x".repeat(30_000));
    const files = await projectContextFiles(project);
    expect(files.map(file => file.path)).toEqual(["AGENTS.md", ".github/copilot-instructions.md"]);
    // `@path` imports stay literal text: nothing outside the root is pulled in.
    expect(files[0].content).toBe("Use pnpm.\n@../secret.txt");
    expect(files.map(file => file.content).join("")).not.toContain("token-123");
    expect(files.map(file => file.content).join("")).not.toContain("parent rules");
    expect(files[1].content.length).toBeLessThan(25_000);
    expect(files[1].content).toContain("truncated");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a convention file that links outside the workspace is skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-context-link-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "outside.md"), "outside");
    try { await symlink(join(root, "outside.md"), join(project, "CLAUDE.md")); }
    catch { return; } // Creating symlinks needs Developer Mode on Windows; nothing to check without one.
    expect(await projectContextFiles(project)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
