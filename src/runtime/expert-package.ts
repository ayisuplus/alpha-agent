import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { hashSkillDirectory, SkillPluginStore } from "../plugins/third-party";
import { copySkillDirectory } from "./skill-snapshot";

export interface ExpertMounts {
  /** Bundled Skills that mount with the expert: its method set is part of the expert state, not a suggestion (§4.4). */
  skills: string[];
  /** The method whose SKILL.md body is injected on activation; a Skill not listed here is read on demand. */
  primarySkill?: string;
  /** Third-party MCP services the method needs; the runtime authorizes each one and pauses on any gap. */
  mcp: string[];
}

/**
 * The handoff declaration (§5): what the expert consumes and produces, who usually follows, and which gate its
 * outputs must pass. Roles and artifact types come from the controlled vocabulary `presets/agents/roles.json`; the
 * same declaration generates the persona's 交接边界 section, so it is written once.
 */
export interface ExpertHandoff {
  role: string;
  consumes: string[];
  produces: string[];
  next: string[];
  gate: string[];
}

export interface ExpertPackage {
  revision: string;
  skills: Array<{ id: string; hash: string }>;
  /** How the package mounts; absent in packages recorded before declarations existed (§5 兼容). */
  mounts?: ExpertMounts;
  /** The expert's handoff declaration; absent in packages recorded before declarations existed (§5 兼容). */
  handoff?: ExpertHandoff;
}

type Previous = { id: string; package?: ExpertPackage };
const skillIdPattern = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/;

/**
 * The package revision covers persona, Skill snapshots and the mount declaration, so editing the declaration is a new
 * version. A package without `mounts` keeps the pre-declaration formula, so old snapshots still verify.
 */
export function packageRevisionHash(persona: string, skills: Array<{ id: string; hash: string }>, mounts?: ExpertMounts): string {
  const parts = [persona, skills.map(item => [item.id, item.hash])];
  return createHash("sha256").update(JSON.stringify(mounts ? [...parts, mounts] : parts)).digest("hex");
}

function packageRoot(dataRoot: string, expertId: string, revision: string): string {
  return join(dataRoot, "expert-packs", expertId, revision);
}

/**
 * The persona file is the expert's four things (§3); its 交接边界 section is generated from the handoff declaration so
 * the declaration is written once and used twice (§5) — personas without one keep the old plain form.
 */
export function personaText(name: string, description: string, instructions: string, handoff?: ExpertHandoff): string {
  const body = `# ${name}\n\n适用范围：${description}\n\n${instructions}\n`;
  if (!handoff) return body;
  return `${body}\n## 交接边界（由 handoff 声明生成）\n\n- 角色：${handoff.role}\n- 消耗的产物：${handoff.consumes.join("、") || "无"}\n- 产出的产物：${handoff.produces.join("、") || "无"}\n- 通常交给：${handoff.next.join("、") || "无"}\n- 交付前必须经过：${handoff.gate.map(role => `${role} gate`).join("、") || "无"}\n`;
}

/** A written handoff declaration (§5); roles and artifact types come from the controlled vocabulary. */
export function validateHandoff(handoff: ExpertHandoff): ExpertHandoff {
  for (const list of [handoff.consumes, handoff.produces, handoff.next, handoff.gate]) {
    if (!Array.isArray(list) || list.some(item => typeof item !== "string" || !item.trim()) || new Set(list).size !== list.length) throw new Error("专家交接声明无效");
  }
  if (typeof handoff.role !== "string" || !handoff.role.trim()) throw new Error("专家交接声明缺少角色");
  return { role: handoff.role.trim(), consumes: [...handoff.consumes], produces: [...handoff.produces], next: [...handoff.next], gate: [...handoff.gate] };
}

/** A versioned package stores persona text, exact read-only Skill resources and the declarations. */
export async function createExpertPackage(dataRoot: string, expertId: string, name: string, description: string, instructions: string, skillIds: string[], previous?: Previous, localSkills: Array<{ id: string; source: string }> = [], mounts?: ExpertMounts, handoff?: ExpertHandoff): Promise<ExpertPackage> {
  if (mounts) {
    if (mounts.primarySkill && !mounts.skills.includes(mounts.primarySkill)) throw new Error(`专家主方法必须在随包 Skill 中：${mounts.primarySkill}`);
    if (mounts.skills.some(id => !skillIds.includes(id))) throw new Error(`专家随包 Skill 不在清单中：${mounts.skills.find(id => !skillIds.includes(id))}`);
    if (new Set(mounts.skills).size !== mounts.skills.length || new Set(mounts.mcp).size !== mounts.mcp.length) throw new Error("专家装载声明存在重复条目");
  }
  const declaration = handoff ? validateHandoff(handoff) : undefined;
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
  const persona = personaText(name, description, instructions, declaration);
  const revision = packageRevisionHash(persona, sources.map(item => ({ id: item.id, hash: item.hash })), mounts);
  const root = packageRoot(dataRoot, expertId, revision);
  const manifest: ExpertPackage = { revision, skills: sources.map(({ id, hash }) => ({ id, hash })), ...(mounts ? { mounts: { skills: [...mounts.skills], ...(mounts.primarySkill ? { primarySkill: mounts.primarySkill } : {}), mcp: [...mounts.mcp] } } : {}), ...(declaration ? { handoff: declaration } : {}) };
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
  if (await readFile(join(root, "PERSONA.md"), "utf8") !== personaText(expert.name, expert.description, expert.instructions, expert.package?.handoff)) throw new Error(`专家人设文件与快照不一致：${expert.id}`);
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
