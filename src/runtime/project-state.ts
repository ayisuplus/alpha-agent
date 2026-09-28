import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProjectStore } from "./projects";
import { TaskLedger } from "./task-ledger";
import { warnUnknownStoreVersion } from "./store-tag";

const AUTHOR = ["-c", "user.name=Alpha Agent", "-c", "user.email=alpha@local.invalid"];
const EXCLUDED = new Set([".git", ".alpha", "node_modules", "dist", "build", "release", "target", ".next", ".cache", "coverage", ".venv", "venv", "__pycache__", "inputs"]);
const SENSITIVE = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.codex|\.npmrc|\.git-credentials|auth\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$|\.(?:pem|p12|pfx|key)$/i;
const LIMIT = 4_000;
const READ_ONLY_TOOLS = new Set(["read", "grep", "alpha_source", "alpha_search", "alpha_crawl", "alpha_research_source", "alpha_task_input"]);

export const mayWriteProject = (toolName: string): boolean => !READ_ONLY_TOOLS.has(toolName);

export interface RepoTurn { root: string; scopes: string[]; dirty: string[]; hashes: Record<string, string | null>; index: Record<string, string>; head: string }
export interface ProjectTurn { runId: string; taskId?: string; key: string; dataRoot: string; projectRoot: string; repos: RepoTurn[]; codeCommits: Array<{ root: string; commit: string }>; memoryCommit?: string; status: "prepared" | "code-committed" | "memory-committed" | "finished"; }

const inside = (root: string, target: string) => {
  const rest = relative(root, target);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const safe = (path: string) => path.split(/[\\/]/).every(part => part && !EXCLUDED.has(part.toLowerCase()) && !SENSITIVE.test(part));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const journalFile = (dataRoot: string, runId: string) => join(dataRoot, "project-turns", `${runId}.json`);
const memoryRoot = (dataRoot: string, key: string) => join(dataRoot, "project-memory", key);

async function withProjectLock<T>(turn: ProjectTurn, work: () => Promise<T>): Promise<T> {
  const directory = join(turn.dataRoot, "project-memory-locks");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${turn.key}.lock`);
  const candidate = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(candidate, String(process.pid), { flag: "wx" });
  let locked = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(candidate, file); locked = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number(await readFile(file, "utf8").catch(() => ""));
        if (!Number.isInteger(owner) || owner <= 0) throw new Error("Project memory is locked; inspect an incomplete prior update");
        try { process.kill(owner, 0); throw new Error("Another process is updating this project memory"); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
        await unlink(file).catch(() => undefined);
      }
    }
    if (!locked) throw new Error("Project memory lock could not be acquired");
    return await work();
  } finally {
    await unlink(candidate).catch(() => undefined);
    if (locked) await unlink(file).catch(() => undefined);
  }
}

async function git(cwd: string, args: string[], required = true): Promise<string> {
  const hooks = args[0] === "commit" ? await mkdtemp(join(tmpdir(), "alpha-empty-git-hooks-")) : null;
  try {
    const config = hooks ? [...AUTHOR, "-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false"] : AUTHOR;
    const child = Bun.spawn(["git", ...config, "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0 && required) throw new Error(`Git ${args[0]} failed in ${cwd}: ${err.trim().slice(0, 400) || out.trim().slice(0, 400)}`);
    return code === 0 ? (args[0] === "status" ? out : out.trim()) : "";
  } finally { if (hooks) await rmdir(hooks); }
}

async function writeJournal(turn: ProjectTurn): Promise<void> {
  const file = journalFile(turn.dataRoot, turn.runId);
  await mkdir(resolve(file, ".."), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  // .alpha/project-turns/<runId>.json (project-turns store): v1 = ProjectTurn plus its format tag; a version bump must migrate at the two journal reads.
  await writeFile(temp, JSON.stringify({ ...turn, format: "project-turns", version: 1 }, null, 2));
  await rename(temp, file);
}

function identity(ledger: TaskLedger | undefined, root: string): string {
  if (ledger?.state.projectId) return `project-${ledger.state.projectId}`;
  return `path-${hash(resolve(ledger?.state.workspaceOrigin?.sourcePath ?? root).toLowerCase())}`;
}

export async function readProjectMemory(dataRoot: string, projectRoot: string, ledger?: TaskLedger): Promise<string> {
  const file = join(memoryRoot(resolve(dataRoot), identity(ledger, projectRoot)), "memory.md");
  return readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
}

export async function readProjectMemorySnapshot(dataRoot: string, projectRoot: string, ledger?: TaskLedger): Promise<{ content: string; commit: string | null }> {
  const content = await readProjectMemory(dataRoot, projectRoot, ledger);
  if (!content) return { content, commit: null };
  const root = memoryRoot(resolve(dataRoot), identity(ledger, projectRoot));
  return { content, commit: await git(root, ["rev-parse", "HEAD"], false) || null };
}

async function status(root: string, scopes: string[]): Promise<string[]> {
  const output = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...scopes]);
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3).replaceAll("\\", "/"));
    if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]!.replaceAll("\\", "/"));
  }
  return [...new Set(paths)].sort();
}

async function indexEntries(root: string, scopes: string[]): Promise<Map<string, string>> {
  const output = await git(root, ["ls-files", "-s", "-z", "--", ...scopes]);
  const entries = new Map<string, string>();
  for (const entry of output.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    const metadata = entry.slice(0, tab);
    entries.set(path, entries.has(path) ? `${entries.get(path)}\n${metadata}` : metadata);
  }
  return entries;
}

async function fileHash(root: string, path: string): Promise<string | null> {
  const full = resolve(root, path);
  if (!inside(root, full)) throw new Error(`Git path leaves project: ${path}`);
  const info = await lstat(full).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile()) throw new Error(`Git change is not a regular file: ${path}`);
  return createHash("sha256").update(await readFile(full)).digest("hex");
}

async function initialBaseline(root: string): Promise<void> {
  const head = await git(root, ["rev-parse", "--verify", "HEAD"], false);
  if (head) return;
  const files = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const staged = (await git(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  if (staged.some(path => !safe(path))) throw new Error("Existing Git index contains excluded files; initial baseline cannot safely commit it");
  const allowed: string[] = [];
  for (const path of files) {
    if (!safe(path)) continue;
    const info = await lstat(resolve(root, path)).catch(() => null);
    if (info?.isFile()) allowed.push(path);
  }
  for (let i = 0; i < allowed.length; i += 80) await git(root, ["add", "--", ...allowed.slice(i, i + 80)]);
  await git(root, ["commit", "--allow-empty", "-m", "alpha: initial safe baseline"]);
}

async function repoAt(root: string, allowedRoots: string[], importedWorktree: boolean, standalone = false): Promise<string> {
  const existing = await git(root, ["rev-parse", "--show-toplevel"], false);
  if (!existing || (standalone && !inside(root, resolve(existing)))) await git(root, ["init", "-b", "main"]);
  const repository = resolve(await git(root, ["rev-parse", "--show-toplevel"]));
  const ancestor = !allowedRoots.some(allowed => inside(allowed, repository)) && allowedRoots.some(allowed => allowed === root && inside(repository, root));
  if (!ancestor && !allowedRoots.some(allowed => inside(allowed, repository))) throw new Error(`Git repository is outside the authorized project directories: ${repository}`);
  const gitDir = resolve(await git(root, ["rev-parse", "--absolute-git-dir"]));
  if (!inside(repository, gitDir) && !importedWorktree) throw new Error(`Git metadata is outside the authorized project directory: ${gitDir}`);
  if (ancestor) {
    if (!await git(repository, ["rev-parse", "--verify", "HEAD"], false)) throw new Error("An ancestor Git repository needs an existing commit before scoped use");
  } else await initialBaseline(repository);
  return repository;
}

/** Called once by the host before a user turn. Model and worker tools never own this operation. */
export async function prepareProjectTurn(input: { dataRoot: string; projectRoot: string; runId: string; ledger?: TaskLedger; roots?: string[] }): Promise<ProjectTurn> {
  const projectRoot = await realpath(input.projectRoot);
  const dataRoot = resolve(input.dataRoot);
  const mounted = input.ledger?.state.projectId ? await new ProjectStore(dataRoot).roots(input.ledger.state.projectId, input.ledger.state.projectVersion ?? 0) : [];
  const roots = input.roots ?? (mounted.length ? mounted : [projectRoot]);
  const canonical = await Promise.all(roots.map(root => realpath(root)));
  const repos = new Map<string, RepoTurn>();
  for (const root of canonical) {
    const generated = inside(join(resolve(dataRoot, ".."), "products"), root);
    const repository = await repoAt(root, canonical, input.ledger?.state.workspaceOrigin?.kind === "git" && root === projectRoot, generated);
    const scope = relative(repository, root).replaceAll("\\", "/") || ".";
    const item = repos.get(repository) ?? { root: repository, scopes: [], dirty: [], hashes: {}, index: {}, head: "" };
    if (!item.scopes.includes(scope)) item.scopes.push(scope);
    repos.set(repository, item);
  }
  for (const repo of repos.values()) {
    repo.head = await git(repo.root, ["rev-parse", "HEAD"]);
    repo.dirty = await status(repo.root, repo.scopes);
    const dirty = repo.dirty.filter(safe);
    const index = dirty.length ? await indexEntries(repo.root, repo.scopes) : new Map<string, string>();
    for (const path of dirty) {
      repo.hashes[path] = await fileHash(repo.root, path);
      repo.index[path] = index.get(path) ?? "";
    }
  }
  const turn: ProjectTurn = { runId: input.runId, taskId: input.ledger?.state.id, key: identity(input.ledger, projectRoot), dataRoot, projectRoot, repos: [...repos.values()], codeCommits: [], status: "prepared" };
  await writeJournal(turn);
  await input.ledger?.recordCheckpointStart();
  return turn;
}

export async function bindProjectTurn(turn: ProjectTurn, ledger: TaskLedger): Promise<void> {
  turn.taskId = ledger.state.id;
  await writeJournal(turn);
  await ledger.recordCheckpointStart();
}

export function assertWritablePaths(turn: ProjectTurn, paths: string[]): void {
  for (const path of paths) {
    const full = resolve(path);
    const repo = turn.repos.find(item => item.scopes.some(scope => inside(resolve(item.root, scope), full)));
    if (!repo) throw new Error(`Modified path is outside the prepared repositories: ${path}`);
    const relativePath = relative(repo.root, full).replaceAll("\\", "/");
    if (!safe(relativePath)) throw new Error(`Modified path is excluded from automatic commits: ${relativePath}`);
    if (repo.dirty.includes(relativePath)) throw new Error(`Cannot separate Alpha edits from pre-existing changes: ${relativePath}`);
  }
}

async function matchingCommit(root: string, runId: string): Promise<string> {
  return git(root, ["log", "HEAD", "-n", "1", `--grep=Alpha-Run-Id: ${runId}`, "--format=%H"], false);
}

async function assertOriginalChangesUnchanged(repo: RepoTurn): Promise<void> {
  const dirty = repo.dirty.filter(safe);
  const index = dirty.length ? await indexEntries(repo.root, repo.scopes) : new Map<string, string>();
  for (const path of dirty) {
    // Older journals include Git's quoted path after each stage entry; identity is already the map key.
    const before = (repo.index[path] ?? "").split("\n").map(entry => entry.split("\t", 1)[0]).join("\n");
    if (await fileHash(repo.root, path) !== repo.hashes[path] || (index.get(path) ?? "") !== before) {
      throw new Error(`Cannot separate Alpha edits from pre-existing changes: ${path}`);
    }
  }
}

async function commitCode(turn: ProjectTurn, repo: RepoTurn, allowCodeChanges: boolean): Promise<string | null> {
  const prior = turn.codeCommits.find(item => item.root === repo.root)?.commit ?? await matchingCommit(repo.root, turn.runId);
  if (prior) return prior;
  if (await git(repo.root, ["rev-parse", "HEAD"]) !== repo.head) throw new Error(`Git HEAD changed during this turn: ${repo.root}`);
  await assertOriginalChangesUnchanged(repo);
  const changed = await status(repo.root, repo.scopes);
  const start = new Set(repo.dirty);
  const owned: string[] = [];
  for (const path of changed) {
    if (!safe(path)) continue;
    if (start.has(path)) continue;
    owned.push(path);
  }
  if (!owned.length) return null;
  if (!allowCodeChanges) throw new Error(`Project changes have no writing tool in this turn: ${owned.join(", ")}`);
  for (let i = 0; i < owned.length; i += 80) {
    const batch = owned.slice(i, i + 80);
    for (const path of batch) {
      const exists = await lstat(resolve(repo.root, path)).then(() => true, () => false);
      if (exists) await git(repo.root, ["add", "--", path]);
      else if (await git(repo.root, ["ls-files", "--", path])) await git(repo.root, ["add", "-u", "--", path]);
    }
  }
  await git(repo.root, ["commit", "--only", "-m", `alpha: checkpoint ${turn.runId}\n\nAlpha-Run-Id: ${turn.runId}`, "--", ...owned]);
  const commit = await git(repo.root, ["rev-parse", "HEAD"]);
  if ((await git(repo.root, ["symbolic-ref", "-q", "HEAD"], false)) === "") await git(repo.root, ["update-ref", `refs/alpha/runs/${turn.runId}`, commit]);
  return commit;
}

function protectedLines(ledger: TaskLedger): string[] {
  const gaps = ledger.completionGaps();
  const verified = ledger.state.status === "active" && ledger.state.phase === "execute" && !gaps.length && !ledger.state.lastFailure;
  const lines = [`# 项目状态`, `最近任务：${ledger.state.id}`, `目标：${ledger.state.objective}`, `任务状态：${verified ? "验收条件已满足" : ledger.state.status}；阶段：${ledger.state.phase ?? "execute"}`];
  for (const item of ledger.state.guidanceHistory ?? []) lines.push(`用户补充：${item.instruction}`);
  if (ledger.state.pendingQuestion) lines.push(`待回答：${ledger.state.pendingQuestion}`);
  if (ledger.state.lastFailure) lines.push(`最近失败：${ledger.state.lastFailure}`);
  if (ledger.state.checkpointError) lines.push(`自动提交问题：${ledger.state.checkpointError}`);
  if (gaps.length) lines.push(`未通过验收：${gaps.join("、")}`);
  return lines;
}

async function memoryText(turn: ProjectTurn, ledger: TaskLedger): Promise<string> {
  const required = protectedLines(ledger);
  const taskFiles = (await readdir(join(turn.dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const related = (await Promise.all(taskFiles.map(name => TaskLedger.load(join(turn.dataRoot, "tasks", name)).catch(() => null))))
    .filter((item): item is TaskLedger => !!item && item.state.id !== ledger.state.id && identity(item, item.state.projectRoot) === turn.key)
    .sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
  for (const item of related.filter(item => item.state.status !== "complete")) {
    required.push(`其他进行中任务 ${item.state.id}：${item.state.objective}；状态 ${item.state.status}`);
    for (const guidance of item.state.guidanceHistory ?? []) required.push(`该任务用户补充：${guidance.instruction}`);
    if (item.state.pendingQuestion) required.push(`该任务待回答：${item.state.pendingQuestion}`);
    if (item.state.lastFailure) required.push(`该任务失败：${item.state.lastFailure}`);
  }
  const heads = await Promise.all(turn.repos.map(async repo => `${repo.root}: ${await git(repo.root, ["rev-parse", "HEAD"])}`));
  const commits = turn.codeCommits.map(item => `${item.root}: ${item.commit}`);
  required.push(`轮次：${turn.runId}`, ...heads.map(value => `当前项目 HEAD：${value}`), ...commits.map(value => `本轮项目提交：${value}`));
  const stable = [...new Set(required)];
  const verified = ledger.state.evidence.filter(item => item.passed && item.revision === ledger.state.revision && (item.contractVersion ?? 1) === (ledger.state.contractVersion ?? 1)).map(item => `${item.criterionId}: ${item.source}`);
  const optional = [...verified.map(value => `已核验证据：${value}`), ...related.filter(item => item.state.status === "complete").slice(0, 3).map(item => `近期完成任务 ${item.state.id}：${item.state.objective}`)];
  const file = join(memoryRoot(turn.dataRoot, turn.key), "memory.md");
  const prior = await readFile(file, "utf8").catch(() => "");
  if (prior) optional.push(`前次状态版本：${hash(prior).slice(0, 12)}`);
  const fit = (items: string[]) => `${[...stable, ...items].join("\n")}\n`;
  if ([...fit([])].length > LIMIT) throw new Error("Project constraints and unresolved state exceed the memory.md limit; review the source requirements");
  while ([...fit(optional)].length > LIMIT && optional.length) optional.pop();
  return fit(optional);
}

/** Idempotent host finalization. The journal survives a crash between the two repositories. */
export async function finalizeProjectTurn(turn: ProjectTurn, ledger: TaskLedger, allowCodeChanges = true): Promise<ProjectTurn> {
  return withProjectLock(turn, () => finalizeUnlocked(turn, ledger, allowCodeChanges));
}

async function finalizeUnlocked(turn: ProjectTurn, ledger: TaskLedger, allowCodeChanges: boolean): Promise<ProjectTurn> {
  const saved = await readFile(journalFile(turn.dataRoot, turn.runId), "utf8").then(value => {
    const prior = JSON.parse(value) as ProjectTurn;
    warnUnknownStoreVersion("project-turns", prior);
    return prior;
  }).catch(() => turn);
  if (saved.status === "finished") return saved;
  for (const repo of saved.repos) {
    if (saved.codeCommits.some(item => item.root === repo.root)) continue;
    const commit = await commitCode(saved, repo, allowCodeChanges);
    if (commit) saved.codeCommits.push({ root: repo.root, commit });
    await writeJournal(saved);
  }
  saved.status = "code-committed";
  await writeJournal(saved);
  if (!saved.memoryCommit) {
    const root = memoryRoot(saved.dataRoot, saved.key);
    await mkdir(root, { recursive: true });
    await repoAt(root, [root], false, true);
    const prior = await matchingCommit(root, saved.runId);
    if (prior) saved.memoryCommit = prior;
    else {
      await writeFile(join(root, "memory.md"), await memoryText(saved, ledger));
      await git(root, ["add", "--", "memory.md"]);
      await git(root, ["commit", "-m", `alpha: project state ${saved.runId}\n\nAlpha-Run-Id: ${saved.runId}`]);
      saved.memoryCommit = await git(root, ["rev-parse", "HEAD"]);
    }
    saved.status = "memory-committed";
    await writeJournal(saved);
  }
  await ledger.recordCheckpoint({ runId: saved.runId, codeCommits: saved.codeCommits, memoryCommit: saved.memoryCommit!, recordedAt: new Date().toISOString() });
  saved.status = "finished";
  await writeJournal(saved);
  return saved;
}

export async function unfinishedProjectTurns(dataRoot: string): Promise<ProjectTurn[]> {
  const directory = join(dataRoot, "project-turns");
  const files = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const turns = await Promise.all(files.map(async file => {
    const turn = JSON.parse(await readFile(join(directory, file), "utf8")) as ProjectTurn;
    warnUnknownStoreVersion("project-turns", turn);
    return turn;
  }));
  return turns.filter(turn => turn.status !== "finished");
}

/** Resume only changes already committed before the crash; never guess ownership after restart. */
export async function recoverProjectTurn(turn: ProjectTurn, ledger: TaskLedger): Promise<ProjectTurn> {
  for (const repo of turn.repos) {
    const recorded = turn.codeCommits.find(item => item.root === repo.root);
    const commit = recorded?.commit ?? await matchingCommit(repo.root, turn.runId);
    if (commit) {
      if (await git(repo.root, ["rev-parse", "HEAD"]) !== commit) throw new Error(`Git HEAD changed after this turn's commit: ${repo.root}`);
      await assertOriginalChangesUnchanged(repo);
      if ((await status(repo.root, repo.scopes)).some(path => safe(path) && !repo.dirty.includes(path))) {
        throw new Error("Uncommitted project changes remain after interruption; review them before another run");
      }
      if (!recorded) turn.codeCommits.push({ root: repo.root, commit });
    } else if (turn.status === "prepared" && (await status(repo.root, repo.scopes)).some(path => safe(path) && !repo.dirty.includes(path))) {
      throw new Error("Uncommitted project changes remain after interruption; review them before another run");
    }
  }
  if (turn.status === "prepared") {
    turn.status = "code-committed";
    await writeJournal(turn);
  }
  return finalizeProjectTurn(turn, ledger, false);
}
