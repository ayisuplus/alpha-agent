import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AgentPresetStore, type LocalExpertImport } from "../src/runtime/agent-presets";

const defaultSource = "C:\\Users\\36322\\.workbuddy\\plugins\\marketplaces\\experts";
const sourceRoot = resolve(process.argv[2] ?? defaultSource);
const dataRoot = resolve(process.argv[3] ?? join(import.meta.dir, "..", ".alpha"));
const dryRun = process.argv.includes("--dry-run");

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "expert"; }
function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function frontmatter(text: string, key: string): string | undefined {
  const header = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return header ? new RegExp(`^${key}:\\s*(.+)$`, "mi").exec(header)?.[1]?.trim().replace(/^['"]|['"]$/g, "") : undefined;
}

const pluginsRoot = await realpath(join(sourceRoot, "plugins"));
const records: LocalExpertImport[] = [];
const report: Array<{ plugin: string; experts: number; skills: string[] }> = [];
for (const plugin of (await readdir(pluginsRoot, { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const pluginRoot = await realpath(join(pluginsRoot, plugin.name));
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".codebuddy-plugin", "plugin.json"), "utf8")) as {
    description?: string; displayDescription?: { zh?: string; en?: string }; skills?: string[];
  };
  const namespace = `wb-${digest(plugin.name).slice(0, 12)}`;
  const skillPaths = Array.isArray(manifest.skills) ? manifest.skills : [];
  const skills = await Promise.all(skillPaths.map(async path => {
    if (typeof path !== "string" || !path.startsWith("./skills/") || path.includes("..")) throw new Error(`Skill 路径无效：${plugin.name}/${path}`);
    const directory = await realpath(join(pluginRoot, path));
    if (!inside(pluginRoot, directory)) throw new Error(`Skill 越界：${plugin.name}/${path}`);
    await readFile(join(directory, "SKILL.md"), "utf8");
    return { id: `${namespace}:${slug(basename(directory))}`, source: directory };
  }));
  if (new Set(skills.map(item => item.id)).size !== skills.length) throw new Error(`Skill ID 重复：${plugin.name}`);
  const agentDir = join(pluginRoot, "agents");
  const agents = await readdir(agentDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let count = 0;
  for (const agent of agents.filter(item => item.isFile() && item.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(agentDir, agent.name);
    const text = await readFile(path, "utf8");
    const stem = agent.name.slice(0, -3);
    const id = `wb-${digest(`${plugin.name}/agents/${agent.name}`).slice(0, 12)}-${slug(stem).slice(0, 48)}`;
    const rawName = frontmatter(text, "name") ?? stem;
    const rawDescription = manifest.displayDescription?.zh ?? frontmatter(text, "description") ?? manifest.description ?? `${plugin.name} 专家`;
    records.push({
      id, name: `${rawName} (${plugin.name})`.slice(0, 80), description: rawDescription.slice(0, 240), instructions: text,
      source: { url: sourceRoot, revision: digest(text), path: `${plugin.name}/agents/${agent.name}` },
      skills,
    });
    count++;
  }
  report.push({ plugin: plugin.name, experts: count, skills: skills.map(item => item.id) });
}
if (!records.length) throw new Error("没有找到顶层专家");
if (new Set(records.map(item => item.id)).size !== records.length) throw new Error("专家 ID 重复");
if (!dryRun) {
  const imported = await new AgentPresetStore(dataRoot).importLocalBatch(records);
  const verified = await new AgentPresetStore(dataRoot).list();
  if (imported.some(item => !verified.some(saved => saved.id === item.id && saved.hash === item.hash))) throw new Error("导入后验证失败");
}
console.log(JSON.stringify({ sourceRoot, dataRoot, dryRun, pluginCount: report.length, expertCount: records.length, skillBindings: records.reduce((sum, item) => sum + item.skills.length, 0), plugins: report }, null, 2));
