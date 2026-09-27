import { randomUUID } from "node:crypto";
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};

async function git(cwd: string, args: string[], signal?: AbortSignal, allowFailure = false): Promise<{ text: string; code: number }> {
  signal?.throwIfAborted();
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0 && !allowFailure) throw new Error(`Git ${args[0]} failed: ${(stderr || stdout).trim().slice(0, 400)}`);
    return { text: stdout, code };
  } finally { signal?.removeEventListener("abort", abort); }
}

function localDate(): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface ScopedBackupResult { commit: string | null; changedFiles: number; largeFiles: string[]; message: string }

/** Commit only the selected mount within an existing Git repository. Never add a remote or push. */
export async function scopedGitBackup(mount: string, signal?: AbortSignal): Promise<ScopedBackupResult> {
  const root = resolve(mount);
  const repository = resolve((await git(root, ["rev-parse", "--show-toplevel"], signal)).text.trim());
  if (!inside(repository, root)) throw new Error("Backup mount is not inside its Git repository");
  await git(root, ["rev-parse", "--verify", "HEAD"], signal);
  const gitDir = resolve((await git(root, ["rev-parse", "--absolute-git-dir"], signal)).text.trim());
  if (!inside(repository, gitDir)) throw new Error("Git metadata is outside the repository");
  const staged = (await git(repository, ["diff", "--cached", "--name-only", "-z"], signal)).text.split("\0").filter(Boolean);
  if (staged.some(path => !inside(root, resolve(repository, path)))) throw new Error("Staged changes outside the selected folder; backup stopped before staging");
  const status = (await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all", "-z", "--", "."], signal)).text;
  const entries = status.split("\0").filter(Boolean);
  if (!entries.length) return { commit: null, changedFiles: 0, largeFiles: [], message: `${localDate()} 每日提交：obsidian 无变更，跳过` };
  const largeFiles: string[] = [];
  for (const entry of entries) {
    if (!/^\?\?|^A |^.A/.test(entry.slice(0, 2))) continue;
    const path = resolve(root, entry.slice(3));
    if (!inside(root, path)) throw new Error("Git reported a path outside the selected folder");
    const size = await stat(path).then(value => value.size, () => 0);
    if (size > 100_000_000) largeFiles.push(relative(root, path));
  }
  await git(root, ["add", "-A", "--", "."], signal);
  const stagedInScope = await git(root, ["diff", "--cached", "--quiet", "--", "."], signal, true);
  if (stagedInScope.code === 0) return { commit: null, changedFiles: entries.length, largeFiles, message: `${localDate()} 每日提交：无可提交变更，跳过` };
  if (stagedInScope.code !== 1) throw new Error("Could not inspect staged changes in the selected folder");
  const hooks = await mkdtemp(join(tmpdir(), `alpha-backup-hooks-${randomUUID()}-`));
  try {
    await git(root, ["-c", "user.name=Alpha Agent", "-c", "user.email=alpha@local.invalid", "-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", "commit", "--only", "-m", `每日备份 ${localDate()}：${entries.length} 个文件\n\n仅 Obsidian 目录`, "--", "."], signal);
  } finally { await rmdir(hooks); }
  const commit = (await git(root, ["rev-parse", "HEAD"], signal)).text.trim();
  const committed = (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], signal)).text.split("\0").filter(Boolean);
  if (committed.some(path => !inside(root, resolve(repository, path)))) throw new Error("Backup commit includes a path outside the selected folder");
  return { commit, changedFiles: committed.length, largeFiles, message: `${localDate()} 每日提交：${commit.slice(0, 7)}，${committed.length} 个文件${largeFiles.length ? `；大文件 ${largeFiles.join(", ")}` : ""}` };
}
