import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedGitBackup } from "../src/runtime/scoped-git-backup";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr || stdout);
  return stdout.trim();
}

test("scoped backup commits only the mounted folder and keeps outside edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-scoped-backup-"));
  try {
    const mount = join(root, "obsidian");
    await mkdir(mount);
    await git(root, "init", "-b", "main");
    await writeFile(join(root, "outside.txt"), "old\n");
    await writeFile(join(mount, "note.md"), "old\n");
    await git(root, "add", "outside.txt", "obsidian/note.md");
    await git(root, "-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "base");
    await writeFile(join(root, "outside.txt"), "user edit\n");
    await writeFile(join(mount, "note.md"), "new note\n");
    await writeFile(join(mount, "new.md"), "new file\n");
    const result = await scopedGitBackup(mount);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(root, "show", "HEAD:obsidian/note.md")).toBe("new note");
    expect(await git(root, "show", "HEAD:obsidian/new.md")).toBe("new file");
    expect(await git(root, "show", "HEAD:outside.txt")).toBe("old");
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("user edit\n");
    expect(await git(root, "status", "--short", "--", "outside.txt")).toContain("outside.txt");
    expect((await scopedGitBackup(mount)).commit).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scoped backup stops when unrelated changes are staged", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-scoped-backup-staged-"));
  try {
    const mount = join(root, "obsidian");
    await mkdir(mount);
    await git(root, "init", "-b", "main");
    await writeFile(join(root, "outside.txt"), "old\n");
    await git(root, "add", "outside.txt");
    await git(root, "-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "base");
    const base = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "outside.txt"), "staged user edit\n");
    await git(root, "add", "outside.txt");
    await writeFile(join(mount, "note.md"), "new note\n");
    await expect(scopedGitBackup(mount)).rejects.toThrow("Staged changes outside");
    expect(await git(root, "rev-parse", "HEAD")).toBe(base);
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("outside.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});
