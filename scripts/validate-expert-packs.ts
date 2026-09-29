// Structural validation for the expert packs in presets/agents (AGENTS.md §3): the registration file, every persona
// document, every packaged Skill and the controlled handoff vocabulary. The upstream `skill-creator/scripts/
// quick_validate.py` that AGENTS.md used to reference does not exist in this repository or in the OMP installation, so
// this script replaces it as the structural gate. Vocabulary and role coverage are checked in
// test/agent-presets.test.ts; keep the two in sync when the format changes.
//
//   bun run validate:packs            validate presets/agents (default)
//   bun run validate:packs <dir>      validate another expert root
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// AGENTS.md §3 asks for four things, not for fixed headings: inputs and prerequisite reading, executable steps,
// deliverables, acceptance and capability gaps. Existing skills name those sections differently (工作步骤/执行/方法,
// 交付/交付物, 验收依据与能力缺口/交接), so the check is by topic keywords over the whole document.
const TOPIC_CHECKS: Array<{ label: string; pattern: RegExp }> = [
  { label: "输入与前置阅读", pattern: /输入|前置阅读|素材|附件|资料|待审|研究对象/ },
  { label: "可执行的工作步骤", pattern: /步骤|执行|方法|流程|工作法|操作|处理|撰写|设计|审查|分析|搜索|清理|验证|计划/ },
  { label: "交付物", pattern: /交付|产出|输出|成品|结果文件|报表|文档/ },
  { label: "验收依据与能力缺口", pattern: /验收|核验|自查|通过标准|能力缺口|交接|缺口|结论|判定|不通过|驳回/ },
];
const FORBIDDEN_PERSONA = "先读取随包方法";

interface Problem { file: string; message: string; advisory?: boolean }

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function frontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const value = (key: string) => lines.find(line => line.trimStart().startsWith(`${key}:`))?.replace(/^\s*[^:]+:\s*/, "").trim();
  return { name: value("name"), description: value("description") };
}

async function validate(root: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  const presetRoot = join(root, "presets", "agents");
  const indexPath = join(presetRoot, "index.json");
  if (!await exists(indexPath)) return [{ file: indexPath, message: "缺少专家注册文件 presetRoot/index.json" }];
  const index = JSON.parse(await readFile(indexPath, "utf8")) as { presets?: Array<{ id?: string; name?: string; description?: string; file?: string; skills?: string[] }> };
  const presets = index.presets ?? [];
  if (!presets.length) problems.push({ file: indexPath, message: "注册文件里没有任何专家" });
  const seen = new Set<string>();
  for (const preset of presets) {
    const label = preset.id ?? preset.file ?? "(未命名条目)";
    if (!preset.id?.trim()) problems.push({ file: indexPath, message: `条目缺少 id：${JSON.stringify(preset).slice(0, 80)}` });
    else if (seen.has(preset.id)) problems.push({ file: indexPath, message: `专家 id 重复：${preset.id}` });
    else seen.add(preset.id);
    if (!preset.name?.trim() || !preset.description?.trim()) problems.push({ file: indexPath, message: `专家 ${label} 缺少 name 或 description` });
    if (!preset.file?.trim()) { problems.push({ file: indexPath, message: `专家 ${label} 缺少 file` }); continue; }
    const personaPath = join(presetRoot, preset.file);
    if (!await exists(personaPath)) { problems.push({ file: personaPath, message: `人设文件不存在：${preset.file}` }); continue; }
    const persona = await readFile(personaPath, "utf8");
    if (!persona.trim()) problems.push({ file: personaPath, message: "人设文件为空" });
    if (persona.includes(FORBIDDEN_PERSONA)) problems.push({ file: personaPath, message: `人设仍要求"${FORBIDDEN_PERSONA}"（§4.4 已改为激活即装载）` });
    // 「交接边界」 is generated into the installed package by scripts/sync-core-experts.ts, not written in the source
    // persona, so its absence here is a prompt to refresh packages, not a structural failure.
    const declaresHandoff = "handoff" in (preset as Record<string, unknown>);
    if (declaresHandoff && !persona.includes("## 交接边界")) problems.push({ file: personaPath, message: "源人设没有「交接边界」段（由 sync-core-experts 生成到安装包；改过 handoff 后请刷新）", advisory: true });
  }
  for (const entry of await readdir(presetRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "SOURCES.md") continue;
    if (entry.name === "index.json") continue;
    const referenced = presets.some(preset => preset.file === entry.name);
    if (!referenced && !["AGENTS.md"].includes(entry.name)) problems.push({ file: join(presetRoot, entry.name), message: "人设文件没有在 index.json 注册" });
  }

  const skillRoot = join(presetRoot, "skills");
  if (await exists(skillRoot)) {
    for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillRoot, entry.name, "SKILL.md");
      if (!await exists(skillFile)) { problems.push({ file: skillFile, message: `Skill 目录缺少 SKILL.md：${entry.name}` }); continue; }
      const text = await readFile(skillFile, "utf8");
      const meta = frontmatter(text);
      if (!meta.name) problems.push({ file: skillFile, message: "SKILL.md 缺少 frontmatter name" });
      else if (meta.name !== entry.name) problems.push({ file: skillFile, message: `frontmatter name「${meta.name}」与目录名「${entry.name}」不一致` });
      if (!meta.description?.trim()) problems.push({ file: skillFile, message: "SKILL.md 缺少 frontmatter description" });
      const body = text.replace(/^---[\s\S]*?\r?\n---/, "").trim();
      // Topic coverage is advisory: skills phrase the four things in their own words (a verdict line instead of a
      // 验收 heading), and a gate that cries wolf would stop being run.
      for (const topic of TOPIC_CHECKS) if (!topic.pattern.test(body)) problems.push({ file: skillFile, message: `没有明确写到「${topic.label}」（§3 的四件事）`, advisory: true });
      if (body.length < 400) problems.push({ file: skillFile, message: `正文过短（${body.length} 字符），不能构成可执行方法` });
      const headings = body.match(/^##+ /gm) ?? [];
      if (headings.length < 2) problems.push({ file: skillFile, message: `只有 ${headings.length} 个二级小节，正文没有可执行结构` });
    }
  }
  return problems;
}

const target = resolve(process.argv[2] ?? ".");
const problems = await validate(target);
const failures = problems.filter(problem => !problem.advisory);
const advisories = problems.filter(problem => problem.advisory);
const relative = (path: string) => path.replace(`${target}\\`, "").replace(`${target}/`, "");
for (const problem of advisories) console.warn(`  提示 ${relative(problem.file)}: ${problem.message}`);
if (failures.length) {
  console.error(`专家包校验失败：${failures.length} 个结构问题（${target}）`);
  for (const problem of failures) console.error(`  ${relative(problem.file)}: ${problem.message}`);
  process.exit(1);
}
console.log(`专家包校验通过：${target}${advisories.length ? `（另有 ${advisories.length} 条提示，未阻断）` : ""}`);
