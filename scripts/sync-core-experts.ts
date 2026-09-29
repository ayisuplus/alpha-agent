// Brings installed core experts up to the current templates. Dry run by default; --apply backs up the library first.
// An installed copy is refreshed only while it still matches a committed version of its template, so experts the
// user edited are never overwritten. --add <id,id> installs the named templates that are not in the library yet.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExpertStore, type Expert } from "../src/runtime/experts";

const repo = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const addAt = args.indexOf("--add");
const add = addAt >= 0 ? (args[addAt + 1] ?? "").split(",").map(item => item.trim()).filter(Boolean) : [];
const dataRoot = resolve(args.find((arg, index) => !arg.startsWith("--") && index !== addAt + 1) ?? join(repo, ".alpha"));

type Persona = { name: string; description: string; instructions: string; skillIds: string[] };
/** Committed history is immutable: entries before the primarySkill rename carried `skill`. */
type IndexEntry = { id: string; name: string; description: string; file: string; primarySkill?: string; skill?: string };

function git(...command: string[]): string | null {
  const result = Bun.spawnSync(["git", ...command], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

/** Every committed version of a template's persona, so an unedited copy from any earlier release is recognised. */
function committedVersions(templateId: string, file: string): Persona[] {
  const commits = (git("log", "--format=%H", "--", "presets/agents/index.json", `presets/agents/${file}`) ?? "").split("\n").filter(Boolean);
  return commits.flatMap(commit => {
    const index = git("show", `${commit}:presets/agents/index.json`);
    const entry = index ? (JSON.parse(index) as { presets: IndexEntry[] }).presets.find(item => item.id === templateId) : undefined;
    const persona = entry ? git("show", `${commit}:presets/agents/${entry.file}`) : null;
    return entry && persona !== null ? [{ name: entry.name, description: entry.description, instructions: persona.trim(), skillIds: (entry.primarySkill ?? entry.skill) ? [`alpha-core:${entry.primarySkill ?? entry.skill}`] : [] }] : [];
  });
}

const samePersona = (a: Persona, b: Persona) => a.name === b.name && a.description === b.description && a.instructions === b.instructions && JSON.stringify(a.skillIds) === JSON.stringify(b.skillIds);
const personaOf = (preset: Expert): Persona => ({ name: preset.name, description: preset.description, instructions: preset.instructions, skillIds: preset.skillIds ?? [] });
const skillHashes = (preset: Expert) => JSON.stringify(preset.package?.skills.map(item => [item.id, item.hash]) ?? []);

const store = new ExpertStore(dataRoot);
const templates = await store.templates();
const index = JSON.parse(await readFile(join(repo, "presets", "agents", "index.json"), "utf8")) as { presets: IndexEntry[] };
const installed = (await store.list()).filter(item => item.basedOn && item.id === `core-${item.basedOn}`);
const report: Array<{ id: string; status: "current" | "refresh" | "edited" | "no-template" }> = [];
for (const copy of installed) {
  const template = templates.find(item => item.id === copy.basedOn);
  const entry = index.presets.find(item => item.id === copy.basedOn);
  if (!template || !entry) { report.push({ id: copy.id, status: "no-template" }); continue; }
  if (samePersona(personaOf(copy), personaOf(template)) && skillHashes(copy) === skillHashes(template) && copy.package?.revision === template.package?.revision) { report.push({ id: copy.id, status: "current" }); continue; }
  const unedited = samePersona(personaOf(copy), personaOf(template)) || committedVersions(template.id, entry.file).some(version => samePersona(personaOf(copy), version));
  report.push({ id: copy.id, status: unedited ? "refresh" : "edited" });
}
for (const id of add) {
  if (!templates.some(item => item.id === id)) throw new Error(`核心专家模板不存在：${id}`);
  if (installed.some(item => item.basedOn === id)) throw new Error(`已在专家库中：core-${id}`);
}
const refresh = report.filter(item => item.status === "refresh").map(item => item.id.slice("core-".length));

let backup: string | undefined;
if (apply && (refresh.length || add.length)) {
  const source = join(dataRoot, "agent-presets.json");
  const directory = join(dataRoot, "expert-library-backups");
  await mkdir(directory, { recursive: true });
  backup = join(directory, `agent-presets-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await copyFile(source, backup);
  if (await readFile(backup, "utf8") !== await readFile(source, "utf8")) throw new Error("专家库备份校验失败");
  await store.syncCoreExperts([...refresh, ...add]);
  for (const expert of await store.enabled()) await store.loadBundledSkills(expert);
}
console.log(JSON.stringify({ apply, dataRoot, backup, refreshed: apply ? refresh : undefined, added: apply ? add : undefined, plan: { refresh, add }, report }, null, 2));
