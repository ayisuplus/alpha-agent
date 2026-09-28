import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { warnUnknownStoreVersion } from "./store-tag";

const PREVIEW_ID = /^[0-9a-f-]{36}$/;

async function sizeOf(path: string): Promise<{ bytes: number; safe: boolean }> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { bytes: 0, safe: true };
  if (info.isSymbolicLink()) return { bytes: 0, safe: false };
  if (info.isFile()) return { bytes: info.size, safe: true };
  if (!info.isDirectory()) return { bytes: 0, safe: false };
  let bytes = 0;
  let safe = true;
  for (const name of await readdir(path)) {
    const child = await sizeOf(join(path, name));
    bytes += child.bytes;
    safe &&= child.safe;
  }
  return { bytes, safe };
}

export interface StalePreview { id: string; path: string; bytes: number }

/** Only Alpha preview snapshots with a matching manifest can be cleaned. Links anywhere inside are skipped. */
export async function stalePreviews(dataRoot: string, protectedIds: Set<string>): Promise<StalePreview[]> {
  const root = resolve(dataRoot, "previews");
  const realRoot = await realpath(root).catch(() => null);
  const realDataRoot = await realpath(dataRoot);
  if (!realRoot || relative(realDataRoot, realRoot) !== "previews") return [];
  const candidates: StalePreview[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PREVIEW_ID.test(entry.name) || protectedIds.has(entry.name)) continue;
    const path = join(root, entry.name);
    const real = await realpath(path).catch(() => null);
    const inside = real ? relative(realRoot, real) : "";
    if (!real || inside !== entry.name || inside.startsWith("..") || isAbsolute(inside)) continue;
    const manifest = await readFile(join(path, "preview.json"), "utf8").then(text => {
      const parsed = JSON.parse(text) as { id?: unknown };
      warnUnknownStoreVersion("preview", parsed);
      return parsed;
    }).catch(() => null);
    if (manifest?.id !== entry.name) continue;
    const size = await sizeOf(path);
    if (size.safe) candidates.push({ id: entry.name, path, bytes: size.bytes });
  }
  return candidates;
}

export async function storageReport(dataRoot: string, productsRoot: string, protectedIds: Set<string>) {
  const categories = await Promise.all([
    ["products", "产品项目", productsRoot],
    ["previews", "预览副本", join(dataRoot, "previews")],
    ["evidence", "验收证据", join(dataRoot, "evidence")],
    ["build-logs", "构建日志", join(dataRoot, "build-logs")],
    ["omp", "模型会话", join(dataRoot, "omp")],
  ].map(async ([id, label, path]) => ({ id, label, path, bytes: (await sizeOf(path)).bytes })));
  const known = categories.filter(item => item.id !== "products").reduce((sum, item) => sum + item.bytes, 0);
  categories.push({ id: "other", label: "其他运行数据", path: dataRoot, bytes: Math.max(0, (await sizeOf(dataRoot)).bytes - known) });
  const eligible = await stalePreviews(dataRoot, protectedIds);
  return { categories, cleanup: { count: eligible.length, bytes: eligible.reduce((sum, item) => sum + item.bytes, 0) } };
}

export async function cleanupStalePreviews(dataRoot: string, protectedIds: Set<string>): Promise<{ removed: number; bytes: number }> {
  const root = await realpath(resolve(dataRoot, "previews")).catch(() => null);
  const realDataRoot = await realpath(dataRoot);
  if (!root || relative(realDataRoot, root) !== "previews") return { removed: 0, bytes: 0 };
  let removed = 0;
  let bytes = 0;
  for (const item of await stalePreviews(dataRoot, protectedIds)) {
    // Verify the absolute target again immediately before a recursive remove.
    const current = await realpath(item.path).catch(() => null);
    if (!current || relative(root, current) !== item.id || protectedIds.has(item.id)) continue;
    if (!(await sizeOf(current)).safe) continue;
    await rm(current, { recursive: true });
    removed++;
    bytes += item.bytes;
  }
  return { removed, bytes };
}
