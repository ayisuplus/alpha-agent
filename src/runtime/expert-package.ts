import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { hashSkillDirectory, SkillPluginStore } from "../plugins/third-party";
import { copySkillDirectory } from "./skill-snapshot";

export interface ExpertPackage {
  revision: string;
  skills: Array<{ id: string; hash: string }>;
}

type Previous = { id: string; package?: ExpertPackage };
const skillIdPattern = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/;

function packageRoot(dataRoot: string, expertId: string, revision: string): string {
  return join(dataRoot, "expert-packs", expertId, revision);
}

export function personaText(name: string, description: string, instructions: string): string {
  return `# ${name}\n\n适用范围：${description}\n\n${instructions}\n`;
}

/** A versioned package stores persona text and exact read-only Skill resources. */
export async function createExpertPackage(dataRoot: string, expertId: string, name: string, description: string, instructions: string, skillIds: string[], previous?: Previous, localSkills: Array<{ id: string; source: string }> = []): Promise<ExpertPackage> {
  const installed = skillIds.some(id => !localSkills.some(item => item.id === id) && !previous?.package?.skills.some(item => item.id === id)) ? await new SkillPluginStore(dataRoot).loadSkills() : [];
  const sources = await Promise.all(skillIds.map(async id => {
    const match = skillIdPattern.exec(id);
    if (!match) throw new Error(`专家 Skill ID 无效：${id}`);
    const previousSkill = previous?.package?.skills.find(item => item.id === id);
    const source = localSkills.find(item => item.id === id)?.source ?? (previousSkill ? join(packageRoot(dataRoot, previous!.id, previous!.package!.revision), "skills", match[1], match[2]) : installed.find(item => item.name === id)?.baseDir);
    if (!source) throw new Error(`专家 Skill 未安装或未启用：${id}`);
    const canonical = await realpath(source);
    const hash = await hashSkillDirectory(canonical);
    if (previousSkill && !localSkills.some(item => item.id === id) && hash !== previousSkill.hash) throw new Error(`专家 Skill 快照已改变：${id}`);
    return { id, source: canonical, hash, pluginId: match[1], name: match[2] };
  }));
  const persona = personaText(name, description, instructions);
  const revision = createHash("sha256").update(JSON.stringify([persona, sources.map(item => [item.id, item.hash])])).digest("hex");
  const root = packageRoot(dataRoot, expertId, revision);
  const manifest: ExpertPackage = { revision, skills: sources.map(({ id, hash }) => ({ id, hash })) };
  if (await Bun.file(join(root, "PERSONA.md")).exists()) {
    await loadExpertPackageSkills(dataRoot, { id: expertId, name, description, instructions, package: manifest });
    return manifest;
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "PERSONA.md"), persona, { flag: "wx" });
  for (const item of sources) {
    const target = join(root, "skills", item.pluginId, item.name);
    await mkdir(dirname(target), { recursive: true });
    if (await copySkillDirectory(item.source, target) !== item.hash) throw new Error(`专家 Skill 快照不一致：${item.id}`);
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  return manifest;
}

export async function loadExpertPackageSkills(dataRoot: string, expert: { id: string; name: string; description: string; instructions: string; package?: ExpertPackage }): Promise<Skill[]> {
  if (!expert.package) return [];
  const root = packageRoot(dataRoot, expert.id, expert.package.revision);
  if (await readFile(join(root, "PERSONA.md"), "utf8") !== personaText(expert.name, expert.description, expert.instructions)) throw new Error(`专家人设文件与快照不一致：${expert.id}`);
  const loaded: Skill[] = [];
  const checkedPlugins = new Set<string>();
  for (const entry of expert.package.skills) {
    const match = skillIdPattern.exec(entry.id);
    if (!match) throw new Error(`专家 Skill ID 无效：${entry.id}`);
    if (!checkedPlugins.has(match[1])) {
      const expected = expert.package.skills.filter(item => item.id.startsWith(`${match[1]}:`)).map(item => item.id.slice(match[1].length + 1)).sort();
      const actual = (await readdir(join(root, "skills", match[1]))).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`专家 Skill 目录与清单不一致：${match[1]}`);
      checkedPlugins.add(match[1]);
    }
    const directory = join(root, "skills", match[1], match[2]);
    if (await hashSkillDirectory(directory) !== entry.hash) throw new Error(`专家 Skill 内容与快照不一致：${entry.id}`);
    const filePath = join(directory, "SKILL.md");
    const content = await readFile(filePath, "utf8");
    const description = /^description:\s*(.+)$/mi.exec(content)?.[1]?.trim() || `${expert.name} 的随包方法`;
    loaded.push({ name: entry.id, description: description.slice(0, 240), filePath, baseDir: directory, source: `expert:${expert.id}`, containRoot: await realpath(root) });
  }
  return loaded;
}
