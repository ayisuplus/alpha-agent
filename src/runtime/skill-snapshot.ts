import { copyFile, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { hashSkillDirectory } from "../plugins/third-party";
import type { WorkOrder } from "./work-orders";

/** Worker Skills are loaded from exact copied snapshots, without global plugin discovery. */
export async function loadWorkerSkillSnapshots(dataRoot: string, order: WorkOrder): Promise<Skill[]> {
  const snapshots = order.skillSnapshots ?? [];
  if (snapshots.length !== (order.skillIds?.length ?? 0)) throw new Error("Worker Skill snapshot is missing");
  const root = join(dataRoot, "plugin-packs");
  const loaded: Skill[] = [];
  for (const id of order.skillIds ?? []) {
    const snapshot = snapshots.find(item => item.id === id);
    const match = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/.exec(id);
    if (!match || !snapshot) throw new Error(`Worker Skill snapshot is missing: ${id}`);
    if (snapshot.path && !/^selected\/[0-9a-f]{64}$/.test(snapshot.path)) throw new Error(`Worker Skill snapshot path is invalid: ${id}`);
    const directory = snapshot.path ? join(root, snapshot.path) : join(root, match[1], "skills", match[2]);
    if (await hashSkillDirectory(directory) !== snapshot.hash) throw new Error(`Worker Skill snapshot changed: ${id}`);
    const filePath = join(directory, "SKILL.md");
    const content = await readFile(filePath, "utf8");
    const description = /^description:\s*(.+)$/mi.exec(content)?.[1]?.trim() || `${id} method`;
    loaded.push({ name: id, description: description.slice(0, 240), filePath, baseDir: directory, source: `worker:${id}`, containRoot: await realpath(snapshot.path ? root : join(root, match[1])) });
  }
  return loaded;
}

/**
 * The one Skill-directory copy used by worker snapshots and expert packaging: refuses symlinks and special files,
 * caps the tree at 8 MB, and returns the content hash the copy must still have later. The source is hashed before
 * and after the copy, so a Skill changing mid-copy is rejected instead of frozen wrong.
 */
export async function copySkillDirectory(source: string, target: string): Promise<string> {
  const before = await hashSkillDirectory(source);
  let total = 0;
  async function walk(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Skill contains unsupported entry: ${entry.name}`);
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      if (entry.isDirectory()) await walk(fromPath, toPath);
      else {
        total += (await stat(fromPath)).size;
        if (total > 8_000_000) throw new Error("Selected Skill exceeds snapshot size limit");
        await copyFile(fromPath, toPath);
      }
    }
  }
  await walk(source, target);
  const after = await hashSkillDirectory(target);
  if (before !== after) throw new Error("Skill changed while it was being copied");
  return after;
}
