import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectReview } from "../src/native/project-review";

const run = promisify(execFile);
async function cleanup(root: string) {
  const actual = await realpath(root);
  if (!actual.startsWith(resolve(tmpdir()) + sep)) throw new Error("Review test left temp root");
  await rm(actual, { recursive: true, force: true });
}

test("project review reads staged, unstaged and untracked status without changing the index or leaving the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-review-"));
  const git = (args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  try {
    await git(["init", "-q"]);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "outside.txt"), "before\n");
    await writeFile(join(root, "nested", "changed.txt"), "before\n");
    await git(["add", "."]);
    await git(["-c", "user.name=Alpha Test", "-c", "user.email=alpha@example.invalid", "commit", "-qm", "fixture"]);
    await writeFile(join(root, "outside.txt"), "outside-change\n");
    await writeFile(join(root, "nested", "staged.txt"), "staged-change\n");
    await git(["add", "nested/staged.txt"]);
    await writeFile(join(root, "nested", "changed.txt"), "unstaged-change\n");
    await writeFile(join(root, "nested", "untracked.txt"), "untracked-content\n");
    const before = await readFile(join(root, ".git", "index"));
    const result = await projectReview(join(root, "nested"));
    expect(result.available).toBe(true);
    expect(result.status).toContain("untracked.txt");
    expect(result.staged).toContain("+staged-change");
    expect(result.unstaged).toContain("+unstaged-change");
    expect(result.status).not.toContain("outside.txt");
    expect(result.unstaged).not.toContain("outside-change");
    expect(result.staged + result.unstaged).not.toContain("untracked-content");
    expect(await readFile(join(root, ".git", "index"))).toEqual(before);
  } finally { await cleanup(root); }
});

test("project review reports a non-Git directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-review-empty-"));
  try {
    const result = await projectReview(root);
    expect(result.available).toBe(false);
    expect(result.reason).toBe("当前项目不是 Git 仓库");
  } finally { await cleanup(root); }
});
