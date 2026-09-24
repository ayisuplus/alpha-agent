import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".ts", ".tsx"]);
const EXCLUDED = new Set([".alpha", ".git", "dist", "node_modules"]);
const SENSITIVE = /^(?:\.ssh|\.aws|\.azure|\.codex|user data|\.env(?:\..*)?|credentials?(?:\..*)?|auth\.json|id_(?:rsa|ed25519)|\.npmrc|\.git-credentials)$/i;
const MAX_FILE_BYTES = 256_000;

export type SourceSnapshot = Record<string, string>;
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
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED.has(entry.name.toLowerCase()) && !SENSITIVE.test(entry.name)) await walk(path);
      } else if (entry.isFile() && !SENSITIVE.test(entry.name) && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const data = await readFile(path);
        if (!data.includes(0)) files[relative(root, path).split(sep).join("/")] = data.length <= MAX_FILE_BYTES
          ? data.toString("utf8")
          : `${data.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n…（文件过长，仅显示前 ${MAX_FILE_BYTES} 字节）`;
      }
    }
  }
  await walk(resolve(root));
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
  await writeFile(temporary, JSON.stringify(review));
  await rename(temporary, file);
  return review;
}

export async function readSourceReviews(dataRoot: string, taskId: string): Promise<SourceReview[]> {
  const directory = join(dataRoot, "reviews", taskId);
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const reviews = await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), "utf8")) as SourceReview));
  return reviews.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}
