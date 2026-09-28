import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { warnUnknownStoreVersion } from "./store-tag";

const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".ts", ".tsx"]);
const SOURCE_EXCLUDED_DIRS = new Set([".alpha", ".git", "dist", "node_modules", ".next", ".cache", ".venv", "venv", "__pycache__"]);
const ROOT_GENERATED_DIRS = new Set(["build", "release", "target", "coverage"]);
export function excludedSourceDirectory(name: string, atRoot: boolean): boolean {
  const normalized = name.toLowerCase();
  return SOURCE_EXCLUDED_DIRS.has(normalized) || (atRoot && ROOT_GENERATED_DIRS.has(normalized));
}
const SENSITIVE = /^(?:\.ssh|\.aws|\.azure|\.codex|user data|\.env(?:\..*)?|credentials?(?:\..*)?|auth\.json|id_(?:rsa|ed25519)|\.npmrc|\.git-credentials)$/i;
const MAX_FILE_BYTES = 256_000;

export type SourceSnapshot = Record<string, string>;
/** Complete hashes for change detection; UI snapshots below intentionally omit binary and long text. */
export async function snapshotSourceHashes(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const projectRoot = resolve(root);
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SENSITIVE.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !excludedSourceDirectory(entry.name, directory === projectRoot)) await walk(path);
      else if (entry.isFile()) files[relative(root, path).split(sep).join("/")] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  await walk(projectRoot);
  return files;
}
export interface SourceChange {
  path: string;
  before: string | null;
  after: string | null;
}
export interface SourceReview {
  taskId: string;
  operationId: string;
  contractVersion: number;
  revision: string | null;
  recordedAt: string;
  changes: SourceChange[];
}

export async function snapshotSource(root: string): Promise<SourceSnapshot> {
  const files: SourceSnapshot = {};
  const projectRoot = resolve(root);
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedSourceDirectory(entry.name, directory === projectRoot) && !SENSITIVE.test(entry.name)) await walk(path);
      } else if (entry.isFile() && !SENSITIVE.test(entry.name) && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const data = await readFile(path);
        if (!data.includes(0)) files[relative(root, path).split(sep).join("/")] = data.length <= MAX_FILE_BYTES
          ? data.toString("utf8")
          : `${data.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n…（文件过长，仅显示前 ${MAX_FILE_BYTES} 字节）`;
      }
    }
  }
  await walk(projectRoot);
  return files;
}

export function sourceChanges(before: SourceSnapshot, after: SourceSnapshot): SourceChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path => before[path] !== after[path]).map(path => ({
    path, before: before[path] ?? null, after: after[path] ?? null,
  }));
}

export async function writeSourceReview(dataRoot: string, input: Omit<SourceReview, "recordedAt" | "changes"> & { before: SourceSnapshot; after: SourceSnapshot }): Promise<SourceReview> {
  const review: SourceReview = {
    taskId: input.taskId, operationId: input.operationId, contractVersion: input.contractVersion,
    revision: input.revision, recordedAt: new Date().toISOString(), changes: sourceChanges(input.before, input.after),
  };
  const directory = join(dataRoot, "reviews", input.taskId);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${input.operationId}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  // .alpha/reviews/<taskId>/<operationId>.json (reviews store): v1 = SourceReview plus its format tag; a version bump must migrate in readSourceReviews().
  await writeFile(temporary, JSON.stringify({ ...review, format: "reviews", version: 1 }));
  await rename(temporary, file);
  return review;
}

export async function readSourceReviews(dataRoot: string, taskId: string): Promise<SourceReview[]> {
  const directory = join(dataRoot, "reviews", taskId);
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const reviews = await Promise.all(names.map(async name => {
    const review = JSON.parse(await readFile(join(directory, name), "utf8")) as SourceReview;
    warnUnknownStoreVersion("reviews", review);
    return review;
  }));
  return reviews.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}
