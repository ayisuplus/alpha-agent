import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { builtinPlugins } from "../plugins";
import { readPluginMCP } from "../plugins/mcp";
import { hashSkillDirectory, SkillPluginStore } from "../plugins/third-party";
import { AgentPresetStore } from "./agent-presets";

export type CapabilityKind = "skill" | "mcp-server" | "mcp-tool" | "builtin-tool";
export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  source: string;
  revision: string;
  hash?: string;
  enabled: boolean;
}

export const expertSkillId = (expertId: string, skillId: string) => `expert-${expertId}:s${createHash("sha256").update(skillId).digest("hex").slice(0, 16)}`;

export async function capabilityPool(dataRoot: string): Promise<CapabilityEntry[]> {
  const plugins = new SkillPluginStore(dataRoot);
  const installed = await plugins.list();
  const skills = await plugins.loadSkills();
  const entries: CapabilityEntry[] = [];
  for (const skill of skills) {
    const plugin = installed.find(item => skill.name.startsWith(`${item.id}:`));
    if (!plugin) continue;
    entries.push({ id: skill.name, kind: "skill", name: skill.name, description: skill.description, source: plugin.id, revision: plugin.revision, hash: await hashSkillDirectory(skill.baseDir), enabled: true });
  }
  for (const expert of await new AgentPresetStore(dataRoot).list()) {
    if (!expert.package?.skills.length) continue;
    for (const skill of await new AgentPresetStore(dataRoot).loadBundledSkills(expert)) {
      const item = expert.package.skills.find(entry => entry.id === skill.name)!;
      entries.push({ id: expertSkillId(expert.id, skill.name), kind: "skill", name: skill.name, description: skill.description, source: `expert:${expert.id}`, revision: expert.package.revision, hash: item.hash, enabled: expert.enabled });
    }
  }
  for (const plugin of installed) {
    const config = await readPluginMCP(join(dataRoot, "plugin-packs", plugin.id), plugin.id);
    for (const server of Object.keys(config.servers)) {
      entries.push({ id: server, kind: "mcp-server", name: server, description: `MCP service from ${plugin.name}`, source: plugin.id, revision: plugin.revision, enabled: plugin.enabled && plugin.mcpEnabled });
    }
  }
  const discovered = await readFile(join(dataRoot, "mcp-tool-catalog.json"), "utf8").then(value => JSON.parse(value) as Array<{ name: string; server: string; description: string; revision: string }>).catch(() => []);
  for (const tool of discovered) {
    const plugin = installed.find(item => tool.server.startsWith(`alpha_${item.id}_`) && item.revision === tool.revision);
    if (plugin) entries.push({ id: tool.name, kind: "mcp-tool", name: tool.name, description: tool.description, source: plugin.id, revision: plugin.revision, enabled: plugin.enabled && plugin.mcpEnabled });
  }
  for (const plugin of builtinPlugins) {
    const tools = plugin.create({ projectRoot: dataRoot, dataRoot, enabled: true }).tools;
    for (const tool of tools) entries.push({ id: tool.name, kind: "builtin-tool", name: tool.label, description: tool.description, source: plugin.id, revision: "builtin", enabled: true });
  }
  return entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export async function resolvePoolSkill(dataRoot: string, id: string): Promise<{ skill: Skill; revision: string; hash: string }> {
  if (id.startsWith("expert-")) {
    const expert = (await new AgentPresetStore(dataRoot).list()).find(item => item.package?.skills.some(skill => expertSkillId(item.id, skill.id) === id));
    if (!expert?.enabled) throw new Error(`Skill is unavailable: ${id}`);
    const skill = (await new AgentPresetStore(dataRoot).loadBundledSkills(expert)).find(item => expertSkillId(expert.id, item.name) === id);
    if (!skill || !expert.package) throw new Error(`Skill is unavailable: ${id}`);
    return { skill, revision: expert.package.revision, hash: await hashSkillDirectory(skill.baseDir) };
  }
  const plugin = (await new SkillPluginStore(dataRoot).list()).find(item => id.startsWith(`${item.id}:`) && item.enabled);
  const skill = (await new SkillPluginStore(dataRoot).loadSkills([id]))[0];
  if (!plugin || !skill) throw new Error(`Skill is unavailable: ${id}`);
  return { skill, revision: plugin.revision, hash: await hashSkillDirectory(skill.baseDir) };
}
