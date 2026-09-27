import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentPresetStore } from "../src/runtime/agent-presets";

const apply = process.argv.includes("--apply");
const dataRoot = resolve(process.argv.find((arg, index) => index > 1 && !arg.startsWith("--")) ?? join(import.meta.dir, "..", ".alpha"));
const store = new AgentPresetStore(dataRoot);
const existing = await store.list();
// Retire only the known bulk-import family; preserve separately created experts.
const retired = existing.filter(item => item.enabled && item.id.startsWith("wb-") && /[\\/]marketplaces[\\/]experts[\\/]?$/.test(item.source?.url ?? ""));
const templates = await store.templates();
for (const item of templates) {
  if (!(await store.loadBundledSkills(item)).length) throw new Error(`核心专家缺少 Skill：${item.id}`);
}
let backup: string | undefined;
if (apply) {
  const source = join(dataRoot, "agent-presets.json");
  if (await Bun.file(source).exists()) {
    const directory = join(dataRoot, "expert-library-backups");
    await mkdir(directory, { recursive: true });
    backup = join(directory, `agent-presets-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await copyFile(source, backup);
    if (await readFile(backup, "utf8") !== await readFile(source, "utf8")) throw new Error("专家库备份校验失败");
  }
  await store.installCoreExperts(retired.map(item => item.id));
  for (const expert of await store.enabled()) await store.loadBundledSkills(expert);
}
console.log(JSON.stringify({ apply, dataRoot, backup, coreExperts: templates.map(item => ({ id: `core-${item.id}`, name: item.name, skills: item.skillIds })), retired: retired.map(item => item.id), enabledAfter: apply ? (await store.enabled()).length : undefined }, null, 2));
