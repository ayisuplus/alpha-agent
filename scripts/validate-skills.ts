// Structural validation for the Alpha Skill plugin (presets/alpha-plugin, plan §5.3): the Claude plugin manifest,
// every SKILL.md's frontmatter and length, trigger-style descriptions, retired vocabulary from the old expert
// system, and the "工具用法" section required of office and media skills. Run it after editing any Skill:
//
//   bun run scripts/validate-skills.ts                 validate the whole plugin (all 30 Skills)
//   bun run scripts/validate-skills.ts --skills=a,b    validate only the listed Skill directories
//   bun run scripts/validate-skills.ts <repo-root>     validate another checkout
//
// Exit code 1 on any structural problem. The trailing summary (Skill count, total description characters) is the
// context-budget input requested in plan §5.3-2.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** All 30 Skill directories the plugin must ship (plan §4.1). */
const EXPECTED_SKILLS = [
  "analyze-results",
  "build-slides",
  "check-content-compliance",
  "craft-documents",
  "craft-game-art",
  "create-content",
  "design-experiments",
  "design-game-systems",
  "design-interface",
  "design-system-contracts",
  "direct-visuals",
  "grow-bilibili",
  "grow-short-video",
  "grow-wechat",
  "handle-documents",
  "implement-backend",
  "implement-frontend",
  "implement-gameplay",
  "organize-files",
  "plant-xiaohongshu",
  "playtest-game",
  "process-data",
  "release-service",
  "review-content-analytics",
  "review-literature",
  "run-live-stream",
  "verify-code",
  "write-articles",
  "write-manuscript",
  "write-story",
];

/** Office skills must document `alpha_office`; media skills the generation tools (plan §5.3-4). */
const TOOL_SECTION_SKILLS: Record<string, true> = {
  "craft-documents": true,
  "build-slides": true,
  "process-data": true,
  "handle-documents": true,
  "create-content": true,
  "direct-visuals": true,
  "craft-game-art": true,
  "grow-short-video": true,
  "implement-frontend": true,
  "implement-gameplay": true,
  "verify-code": true,
  "release-service": true,
  "plant-xiaohongshu": true,
  "run-live-stream": true,
  "review-content-analytics": true,
};

/** Skills that operate web pages must name the real browser entry (eval prelude) and its stable-use pattern. */
const BROWSER_SECTION_SKILLS: Record<string, true> = {
  "create-content": true,
  "grow-short-video": true,
  "implement-frontend": true,
  "implement-gameplay": true,
  "verify-code": true,
  "release-service": true,
  "plant-xiaohongshu": true,
  "run-live-stream": true,
  "review-content-analytics": true,
};

/** Retired expert-system vocabulary that must not survive the merge (plan §5.3-1, §5.3-6). */
const RETIRED_TERMS: Array<{ label: string; pattern: RegExp }> = [
  { label: "交接", pattern: /交接/ },
  { label: "工单", pattern: /工单/ },
  // Word boundaries so neutral words like "gateway"/"delegate" are not false positives.
  { label: "handoff", pattern: /\bhand[- ]?off\b/i },
  { label: "gate", pattern: /\bgate\b/i },
  { label: "alpha_plan", pattern: /alpha[-_]?plan/i },
  { label: "“你是 Alpha 的”", pattern: /你是\s*Alpha\s*的/i },
];

/** A description must say when to use the Skill: 当…时 / 用于 / 适用于 / …时使用, or English when/for/use when. */
const TRIGGER_PATTERN = /(当[^\n]{0,60}?时|用于|适用于|时使用|\bwhen\b|\buse when\b|\bfor\b)/i;
const CJK_PATTERN = /[一-鿿]/;
const KEYWORD_PATTERN = /[A-Za-z]{2,}/;

interface Problem { file: string; message: string }

/** Read a UTF-8 file, null when it does not exist (skill and manifest paths are probed before use). */
async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function frontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const value = (key: string) => lines.find(line => line.trimStart().startsWith(`${key}:`))?.replace(/^\s*[^:]+:\s*/, "").trim();
  return { name: value("name"), description: value("description") };
}

async function validate(root: string, only?: string[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  const pluginRoot = join(root, "presets", "alpha-plugin");

  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const manifestRaw = await readOptional(manifestPath);
  if (manifestRaw === null) {
    problems.push({ file: manifestPath, message: "缺少插件清单 .claude-plugin/plugin.json" });
  } else {
    try {
      const manifest = JSON.parse(manifestRaw) as { name?: unknown };
      if (typeof manifest.name !== "string" || !manifest.name.trim()) {
        problems.push({ file: manifestPath, message: "plugin.json 缺少 name（--plugin-dir 用它作为插件标识）" });
      }
    } catch (error) {
      problems.push({ file: manifestPath, message: `plugin.json 无法解析：${(error as Error).message}` });
    }
  }

  const skillRoot = join(pluginRoot, "skills");
  const expected = only ?? EXPECTED_SKILLS;
  for (const name of expected) {
    const skillFile = join(skillRoot, name, "SKILL.md");
    const text = await readOptional(skillFile);
    if (text === null) {
      problems.push({ file: skillFile, message: `Skill 目录缺少 SKILL.md：${name}` });
      continue;
    }
    const meta = frontmatter(text);
    if (!meta.name) problems.push({ file: skillFile, message: "SKILL.md 缺少 frontmatter name" });
    else if (meta.name !== name) problems.push({ file: skillFile, message: `frontmatter name「${meta.name}」与目录名「${name}」不一致` });
    const description = meta.description;
    if (!description?.trim()) {
      problems.push({ file: skillFile, message: "SKILL.md 缺少 frontmatter description" });
    } else {
      if (!TRIGGER_PATTERN.test(description)) problems.push({ file: skillFile, message: "description 没有触发场景措辞（当…时 / 用于 / 适用于 / …时使用 / when / for）" });
      if (!CJK_PATTERN.test(description)) problems.push({ file: skillFile, message: "description 缺中文关键词" });
      if (!KEYWORD_PATTERN.test(description)) problems.push({ file: skillFile, message: "description 缺英文关键词" });
    }

    const body = text.replace(/^---[\s\S]*?\r?\n---/, "").trim();
    if (!body) problems.push({ file: skillFile, message: "正文为空" });
    if (!/^# +\S/m.test(body)) problems.push({ file: skillFile, message: "正文没有标题（缺少 # 开头的一级标题）" });
    const bodyLines = body ? body.split(/\r?\n/).length : 0;
    const totalLines = text.trim().split(/\r?\n/).length;
    if (bodyLines <= 8) problems.push({ file: skillFile, message: `正文只有 ${bodyLines} 行，不足 8 行，不构成可执行方法` });
    if (totalLines >= 400) problems.push({ file: skillFile, message: `全文 ${totalLines} 行，超过 400 行上限` });

    for (const term of RETIRED_TERMS) {
      if (term.pattern.test(body) || term.pattern.test(description ?? "")) {
        problems.push({ file: skillFile, message: `含已退役术语「${term.label}」` });
      }
    }
    if (TOOL_SECTION_SKILLS[name] && !/^##+ *工具用法/m.test(body)) {
      problems.push({ file: skillFile, message: "缺少「## 工具用法」一节（办公/媒体/浏览器类 Skill 必写）" });
    }
    if (BROWSER_SECTION_SKILLS[name] && (!body.includes("browser` 命名空间") || !body.includes("元素句柄"))) {
      problems.push({ file: skillFile, message: "缺少浏览器自动化稳定用法（应写明 eval 的 browser 命名空间与元素句柄点击）" });
    }
  }

  // Directories outside the expected list would ship unreviewed; flag them (full runs only).
  if (!only) {
    try {
      for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && !EXPECTED_SKILLS.includes(entry.name)) {
          problems.push({ file: join(skillRoot, entry.name), message: `未在 30 个 Skill 名单内：${entry.name}` });
        }
      }
    } catch {
      // skills/ itself missing is already reported through the per-skill SKILL.md checks above.
    }
  }
  return problems;
}

const args = process.argv.slice(2);
let only: string[] | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--skills=")) only = arg.slice("--skills=".length).split(",").map(s => s.trim()).filter(Boolean);
  else if (arg === "--skills") only = (args[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  else positional.push(arg);
}
const target = resolve(positional[0] ?? ".");
const problems = await validate(target, only);
for (const problem of problems) console.error(`  ${problem.file.replace(`${target}\\`, "").replace(`${target}/`, "")}: ${problem.message}`);
if (problems.length) {
  console.error(`Skill 校验失败：${problems.length} 个结构问题（${target}）`);
  process.exit(1);
}

// Context-budget summary (plan §5.3-2): how many Skills ship and what their descriptions cost in context.
const skillRoot = join(target, "presets", "alpha-plugin", "skills");
let descriptionChars = 0;
const checked = only ?? EXPECTED_SKILLS;
for (const name of checked) {
  const text = await readOptional(join(skillRoot, name, "SKILL.md"));
  if (text !== null) descriptionChars += (frontmatter(text).description ?? "").length;
}
console.log(`Skill 校验通过：${checked.length} 个 Skill（${target}）`);
console.log(`Skill 数量：${checked.length}`);
console.log(`description 总字符数：${descriptionChars}（${checked.length} 条合计，供上下文占用评估）`);
