import { readFile, realpath } from "node:fs/promises";
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
