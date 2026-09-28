import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TaskLedger, fingerprintSource } from "./task-ledger";
import type { ImportSnapshot } from "./workspace-import";
import { warnUnknownStoreVersion } from "./store-tag";

export interface ApplyChange {
  path: string;
  action: "add" | "modify" | "delete";
  sourceHash: string | null;
  managedHash: string | null;
  conflict: boolean;
}

const OMIT = new Set([".git", ".alpha", "node_modules", "dist", "build", "release", "target", ".next", ".cache", "coverage", "__pycache__"]);
const SECRET = /^(?:\.env(?:\..*)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|p12|pfx|key|log)$/i;
const inside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fileHash(path: string): Promise<string | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symbolic link is not allowed during apply: ${path}`);
    return hash(await readFile(path));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function existingParent(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (dirname(path) === path) throw error;
    return existingParent(dirname(path));
  }
}

async function managedFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath.split("/").some(part => OMIT.has(part) || SECRET.test(part)) || item.isSymbolicLink()) continue;
    if (item.isDirectory()) files.push(...await managedFiles(root, path));
    else if (item.isFile()) files.push(relativePath);
  }
  return files;
}

async function snapshotFor(ledger: TaskLedger, dataRoot: string): Promise<ImportSnapshot> {
  const file = ledger.state.workspaceOrigin?.snapshotFile;
  if (ledger.state.taskType !== "code-change" || !file || !inside(join(resolve(dataRoot), "imports"), resolve(file))) throw new Error("Task has no managed import snapshot");
  const snapshot = JSON.parse(await readFile(file, "utf8")) as ImportSnapshot;
  warnUnknownStoreVersion("imports", snapshot);
  if (resolve(snapshot.managedPath) !== resolve(ledger.state.projectRoot) || resolve(snapshot.sourcePath) !== resolve(ledger.state.workspaceOrigin?.sourcePath ?? "")) throw new Error("Import snapshot does not match task workspace");
  return snapshot;
}

export async function reviewCodeApply(ledger: TaskLedger, dataRoot: string): Promise<{ revision: string | null; changes: ApplyChange[]; conflicts: string[] }> {
  if (await fingerprintSource(ledger.state.projectRoot) !== ledger.state.revision) throw new Error("Managed source changed after the reviewed revision");
  const snapshot = await snapshotFor(ledger, dataRoot);
  const sourceRoot = await realpath(snapshot.sourcePath);
  const managedRoot = await realpath(snapshot.managedPath);
  const candidates = [...new Set([...Object.keys(snapshot.files), ...await managedFiles(managedRoot)])].sort();
  const changes: ApplyChange[] = [];
  for (const path of candidates) {
    const source = resolve(sourceRoot, path);
    const managed = resolve(managedRoot, path);
    if (!inside(sourceRoot, source) || !inside(managedRoot, managed)) throw new Error(`Invalid import file path: ${path}`);
    const [sourceHash, managedHash] = await Promise.all([fileHash(source), fileHash(managed)]);
    const baseline = snapshot.files[path] ?? null;
    if (managedHash === baseline) continue;
    const conflict = sourceHash !== baseline && sourceHash !== managedHash;
    changes.push({ path, action: baseline === null ? "add" : managedHash === null ? "delete" : "modify", sourceHash, managedHash, conflict });
  }
  return { revision: ledger.state.revision, changes, conflicts: changes.filter(item => item.conflict).map(item => item.path) };
}

/** Apply only a reviewed revision, after checking every source file against the import snapshot. */
export async function applyCodeChanges(ledger: TaskLedger, dataRoot: string, reviewedRevision: string): Promise<ApplyChange[]> {
  if (ledger.state.status !== "complete" || ledger.state.revision !== reviewedRevision) throw new Error("Review the current completed revision before applying it");
  const review = await reviewCodeApply(ledger, dataRoot);
  if (review.conflicts.length) throw new Error(`Source changed since import: ${review.conflicts.join(", ")}`);
  const sourceRoot = await realpath(ledger.state.workspaceOrigin!.sourcePath!);
  for (const change of review.changes) {
    const source = resolve(sourceRoot, change.path);
    const managed = resolve(ledger.state.projectRoot, change.path);
    if (!inside(sourceRoot, source)) throw new Error(`Invalid apply path: ${change.path}`);
    if (await fileHash(source) !== change.sourceHash) throw new Error(`Source changed during apply: ${change.path}`);
    const parent = await existingParent(dirname(source));
    if (!inside(sourceRoot, parent)) throw new Error(`Source link leaves project: ${change.path}`);
    if (change.action === "delete") await unlink(source);
    else {
      await mkdir(dirname(source), { recursive: true });
      const temporary = `${source}.${randomUUID()}.tmp`;
      await copyFile(managed, temporary);
      await rename(temporary, source);
    }
  }
  return review.changes;
}
