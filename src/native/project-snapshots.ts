import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getWindowsShortPath } from "@oh-my-pi/pi-natives/path";

type FileState = { blob: string; mode: string };
type Snapshot = { commit: string; files: Record<string, FileState>; index: string | null };
export type SnapshotTurn = { id: string; sessionId: string; startedAt: string; finishedAt?: string; outcome?: string; start: Snapshot; end?: Snapshot };
type Restoration = { id: string; turnId: string; before: Snapshot; after: Snapshot; undone: boolean; status?: "applying" | "complete" | "failed"; error?: string };
type Ledger = { turns: SnapshotTurn[]; restorations: Restoration[] };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const blobHash = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const inside = (root: string, path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part); };

/** Alpha owns this Git database. The user's repository/index is only read. */
export class ProjectSnapshots {
  private queues = new Map<string, Promise<unknown>>();
  private active = new Map<string, string>();
  constructor(private dataRoot: string, private runtimeRoots: string[] = []) {}
  private excluded(path: string) { return [this.dataRoot, ...this.runtimeRoots].some(root => inside(root, path)); }
  private async location(root: string) {
    root = await realpath(root);
    const directory = join(this.dataRoot, "native", "snapshots", hash(process.platform === "win32" ? root.toLowerCase() : root));
    await mkdir(directory, { recursive: true });
    const gitDirectory = getWindowsShortPath(directory);
    return { root, directory: gitDirectory, repo: join(gitDirectory, "objects.git"), ledger: join(directory, "ledger.json") };
  }
  private async git(cwd: string, args: string[], input?: Uint8Array | string, repo?: string, index?: string): Promise<Buffer> {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_AUTHOR_NAME: "Alpha snapshots", GIT_AUTHOR_EMAIL: "snapshot@localhost", GIT_COMMITTER_NAME: "Alpha snapshots", GIT_COMMITTER_EMAIL: "snapshot@localhost", ...(index ? { GIT_INDEX_FILE: index } : {}) });
    const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", ...(repo ? ["--git-dir", repo] : []), ...args], { cwd: getWindowsShortPath(cwd), env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    if (input !== undefined) { child.stdin!.write(input); child.stdin!.end(); }
    const [output, errors, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(errors.trim() || `Git exited ${code}`);
    return Buffer.from(output);
  }
  private async ledger(path: string): Promise<Ledger> { return readFile(path, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return { turns: [], restorations: [] }; throw error; }); }
  private async save(path: string, ledger: Ledger) { const temporary = path + ".tmp"; await writeFile(temporary, JSON.stringify(ledger)); await rename(temporary, path); }
  private async locked<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const key = (await realpath(root)).toLowerCase(), prior = this.queues.get(key) ?? Promise.resolve();
    const current = prior.then(operation); this.queues.set(key, current.catch(() => undefined)); return current;
  }
  private async paths(root: string): Promise<{ paths: string[]; index: string | null }> {
    try {
      const [files, staged] = await Promise.all([this.git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."]), this.git(root, ["ls-files", "--stage", "-z", "--", "."])]);
      const submodules = new Set(staged.toString("utf8").split("\0").filter(line => line.startsWith("160000 ")).map(line => line.slice(line.indexOf("\t") + 1)));
      return { paths: [...new Set(files.toString("utf8").split("\0").filter(path => path && !submodules.has(path)))], index: hash(staged) };
    } catch (error) {
      if (!String(error).includes("not a git repository")) throw error;
      const paths: string[] = [];
      const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) {
        if ([".git", ".alpha", "node_modules"].includes(entry.name)) continue;
        const target = join(dir, entry.name); if (this.excluded(target)) continue;
        if (entry.isDirectory()) await walk(target); else if (entry.isFile() || entry.isSymbolicLink()) paths.push(relative(root, target));
      } }; await walk(root); return { paths, index: null };
    }
  }
  private async bytes(root: string, path: string): Promise<Buffer | null> {
    const target = resolve(root, path);
    if (!inside(root, target) || this.excluded(target) || path.split(/[\\/]/).includes(".git")) throw new Error(`Snapshot path escapes project: ${path}`);
    let info;
    try { info = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!info.isFile() || !inside(root, await realpath(target))) throw new Error(`Snapshot refuses linked/non-file entry: ${path}`);
    if (info.size > 50_000_000) throw new Error(`Snapshot file exceeds 50 MB: ${path}`);
    return readFile(target);
  }
  private async inspect(root: string) {
    const listing = await this.paths(root), files: Record<string, FileState> = {}; let size = 0;
    for (const path of listing.paths) {
      if (this.excluded(resolve(root, path)) || path.split(/[\\/]/).includes(".git")) continue;
      const bytes = await this.bytes(root, path); if (bytes === null) continue;
      size += bytes.length; if (size > 512_000_000) throw new Error("Project snapshot exceeds 512 MB; ignore generated files before continuing");
      files[path] = { blob: blobHash(bytes), mode: "100644" };
    }
    return { files, index: listing.index };
  }
  private conflicts(expected: Pick<Snapshot, "files" | "index">, current: Pick<Snapshot, "files" | "index">) {
    const conflicts = [...new Set([...Object.keys(expected.files), ...Object.keys(current.files)])].filter(path => expected.files[path]?.blob !== current.files[path]?.blob);
    if (expected.index !== current.index) conflicts.push("[Git index changed]"); return conflicts;
  }
  private async capture(location: Awaited<ReturnType<ProjectSnapshots["location"]>>, label: string): Promise<Snapshot> {
    const { root, repo } = location;
    if (!await lstat(join(repo, "HEAD")).then(() => true, () => false)) { await mkdir(repo, { recursive: true }); await this.git(root, ["init", "--bare", "--object-format=sha1"], undefined, repo); }
    const state = await this.inspect(root), entries = Object.entries(state.files), lines: string[] = [];
    const oids = entries.length ? (await this.git(root, ["hash-object", "-w", "--stdin-paths", "--no-filters"], entries.map(([path]) => JSON.stringify(resolve(root, path))).join("\n") + "\n", repo)).toString().trim().split("\n") : [];
    if (oids.length !== entries.length) throw new Error("Git snapshot object count mismatch");
    entries.forEach(([path, file], index) => {
      if (oids[index] !== file.blob) throw new Error(`File changed while creating snapshot: ${path}`);
      lines.push(`${file.mode} ${oids[index]}\t${path.replaceAll("\\", "/")}\0`);
    });
    const index = join(location.directory, randomUUID() + ".index");
    try {
      await this.git(root, ["read-tree", "--empty"], undefined, repo, index);
      if (lines.length) await this.git(root, ["update-index", "-z", "--index-info"], lines.join(""), repo, index);
      const tree = (await this.git(root, ["write-tree"], undefined, repo, index)).toString().trim();
      const commit = (await this.git(root, ["commit-tree", tree], label, repo)).toString().trim();
      await this.git(root, ["update-ref", `refs/alpha/${randomUUID()}`, commit], undefined, repo);
      const conflicts = this.conflicts(state, await this.inspect(root)); if (conflicts.length) throw new Error(`Project changed while creating snapshot: ${conflicts.join(", ")}`);
      return { ...state, commit };
    } finally { await unlink(index).catch(() => undefined); }
  }
  async begin(root: string, sessionId: string) {
    return this.locked(root, async () => {
      const location = await this.location(root), ledger = await this.ledger(location.ledger);
      const key = `${location.root}\0${sessionId}`;
      const existing = ledger.turns.find(turn => turn.sessionId === sessionId && !turn.finishedAt);
      if (existing && this.active.get(key) === existing.id) return existing;
      if (existing) { existing.finishedAt = new Date().toISOString(); existing.outcome = "interrupted-before-recovery"; }
      const turn: SnapshotTurn = { id: randomUUID(), sessionId, startedAt: new Date().toISOString(), start: await this.capture(location, "Task start") };
      ledger.turns.push(turn); await this.save(location.ledger, ledger); this.active.set(key, turn.id); return turn;
    });
  }
  async finish(root: string, sessionId: string, outcome: string) {
    return this.locked(root, async () => {
      const location = await this.location(root), ledger = await this.ledger(location.ledger);
      const turn = ledger.turns.find(turn => turn.sessionId === sessionId && !turn.finishedAt); if (!turn || this.active.get(`${location.root}\0${sessionId}`) !== turn.id) return;
      turn.end = await this.capture(location, "Task settled"); turn.finishedAt = new Date().toISOString(); turn.outcome = outcome;
      await this.save(location.ledger, ledger); this.active.delete(`${location.root}\0${sessionId}`); return turn;
    });
  }
  async list(root: string) { const location = await this.location(root); const ledger = await this.ledger(location.ledger); return { turns: ledger.turns.map(({ start, end, ...turn }) => ({ ...turn, settled: !!end, changed: end ? Object.keys({ ...start.files, ...end.files }).filter(path => start.files[path]?.blob !== end.files[path]?.blob) : [] })), restorations: ledger.restorations.map(({ before, after, ...item }) => item) }; }
  async preview(root: string, id: string, redo = false) {
    const location = await this.location(root), ledger = await this.ledger(location.ledger);
    const restoration = redo ? ledger.restorations.find(item => item.id === id && !item.undone) : undefined;
    const turn = ledger.turns.find(item => item.id === id);
    const from = redo ? restoration?.after : turn?.end, to = redo ? restoration?.before : turn?.start;
    if (!from || !to) throw new Error("Only a settled task or an active restoration can be restored");
    const conflicts = this.conflicts(from, await this.inspect(location.root));
    const diff = (await this.git(location.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", from.commit, to.commit], undefined, location.repo)).toString("utf8");
    return { conflicts, diff };
  }
  async restore(root: string, id: string, redo = false) {
    return this.locked(root, async () => {
      const location = await this.location(root), ledger = await this.ledger(location.ledger);
      const restoration = redo ? ledger.restorations.find(item => item.id === id && !item.undone) : undefined;
      const turn = ledger.turns.find(item => item.id === id);
      const from = redo ? restoration?.after : turn?.end, to = redo ? restoration?.before : turn?.start;
      if (!from || !to) throw new Error("Only a settled task or an active restoration can be restored");
      const conflicts = this.conflicts(from, await this.inspect(location.root)); if (conflicts.length) return { restored: false, conflicts };
      const changed = Object.keys({ ...from.files, ...to.files }).filter(path => from.files[path]?.blob !== to.files[path]?.blob);
      // Persist recovery objects before changing files, including across process termination.
      const backup: Restoration = { id: randomUUID(), turnId: redo ? restoration!.turnId : id, before: from, after: { ...to, index: from.index }, undone: false, status: "applying" };
      ledger.restorations.push(backup); await this.save(location.ledger, ledger);
      const applied: string[] = [];
      const write = async (path: string, file?: FileState) => {
        const target = resolve(location.root, path); if (!inside(location.root, target)) throw new Error("Restore path escapes project");
        if (!file) { await unlink(target); return; }
        let ancestor = dirname(target);
        while (!await lstat(ancestor).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) ancestor = dirname(ancestor);
        if (!inside(location.root, await realpath(ancestor))) throw new Error("Restore directory is linked outside project");
        await mkdir(dirname(target), { recursive: true });
        if (!inside(location.root, await realpath(dirname(target)))) throw new Error("Restore directory is linked outside project");
        const bytes = await this.git(location.root, ["cat-file", "blob", file.blob], undefined, location.repo), temporary = target + `.alpha-restore-${randomUUID()}`;
        try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, target); } finally { await unlink(temporary).catch(() => undefined); }
      };
      try {
        for (const path of changed) {
          const current = await this.bytes(location.root, path); if ((current === null ? undefined : blobHash(current)) !== from.files[path]?.blob) throw new Error(`File changed during restore: ${path}`);
          await write(path, to.files[path]); applied.push(path);
        }
        const after = await this.capture(location, redo ? "Restore redo" : "Restore undo");
        const moved = this.conflicts(backup.after, after); if (moved.length) throw new Error(`Project changed during restore: ${moved.join(", ")}`);
        backup.after = after; backup.status = "complete";
        if (redo) { restoration!.undone = true; backup.undone = true; }
        await this.save(location.ledger, ledger);
      } catch (error) {
        const rollbackConflicts: string[] = [];
        for (const path of applied.reverse()) {
          const current = await this.bytes(location.root, path);
          if ((current === null ? undefined : blobHash(current)) === to.files[path]?.blob) await write(path, from.files[path]); else rollbackConflicts.push(path);
        }
        backup.status = "failed"; backup.undone = true;
        backup.error = `${String(error)}${rollbackConflicts.length ? `; concurrent edits preserved: ${rollbackConflicts.join(", ")}` : "; applied files rolled back"}`;
        await this.save(location.ledger, ledger);
        throw new Error(backup.error);
      }
      return { restored: true, conflicts: [], changed };
    });
  }
}
