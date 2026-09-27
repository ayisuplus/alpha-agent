import { Database } from "bun:sqlite";
import { join } from "node:path";
import { AutomationStore, type AutomationInput } from "../src/runtime/automations";
import { ProjectStore } from "../src/runtime/projects";

const workspace = "G:\\知识库\\obsidian";
const dataRoot = join(import.meta.dir, "..", ".alpha");
const database = new Database("C:\\Users\\36322\\.workbuddy\\workbuddy.db", { readonly: true });
const sourceIds = [
  "b9729d6d-0774-4586-8afb-ef56732e57c2", // 整理先运行
  "cdebed28-1fa1-417d-9446-bfdab44a72bf", // 为次日出题
  "f0962b7a-6349-4bbe-9729-610ff2a40050", // 最后备份
];
type Source = { id: string; name: string; prompt: string; status: string; rrule: string; cwds: string; model_id: string; push_to_wechat: number; push_to_wecom_bot: number; connector_ids_json: string; skills_json: string };

function convertPrompt(source: Source): string {
  let prompt = source.prompt;
  if (source.id === sourceIds[0]) {
    const start = prompt.indexOf("【第零步 A：");
    const end = prompt.indexOf("【第零步 B：");
    if (start < 0 || end < start) throw new Error("WorkBuddy organizer instructions changed");
    prompt = prompt.slice(0, start) + `【第零步 A：Windows 扫描自检】\nAlpha 在 Windows PowerShell 运行。用 Get-ChildItem -LiteralPath <目录> -Recurse -Force，并按 FullName、Extension、LastWriteTime 筛选；记录并报告扫描错误，不隐藏 stderr。候选为空时，以 2026-01-01 为下界重新扫描 02-大三上 的纪要 Markdown；仍为空或出错则报告工具故障，不得宣称没有新资料。\n\n` + prompt.slice(end);
    prompt = prompt.replace(/\/usr\/bin\/find "G:\/知识库\/obsidian\/02-大三上" -path "\*纪要\*" -name "\*\.md" -newermt "<LOWER>" -print \| sort/g, "用 PowerShell 递归列出 02-大三上 中路径含‘纪要’且扩展名为 .md、LastWriteTime 晚于 LOWER 的文件，按路径排序");
    prompt = prompt.replace("用 `/usr/bin/find ... -printf` 列出", "用 PowerShell Get-ChildItem 递归列出");
    prompt = prompt.replace("同一个 `<LOWER>`；一律 `/usr/bin/find`", "同一个 `<LOWER>`；一律用 PowerShell Get-ChildItem");
    prompt = prompt.replace(/^\s*`\/usr\/bin\/find "G:\/知识库\/obsidian".*$/gm, "  用 PowerShell Get-ChildItem 递归扫描整个 Obsidian 库；排除 .obsidian、.workbuddy、.git 和 _markdown 子树，按 LastWriteTime > LOWER 筛选并排序。");
    if (prompt.includes("/usr/bin/find")) throw new Error("An unsupported GNU find command remains");
    prompt = `【晚间流程】每天 22:00 先整理当天及水位线以来的迟到资料，再由后续任务生成次日日练。水位线和原始资料保护规则保持不变。\n\n${prompt}`;
  } else if (source.id === sourceIds[1]) {
    prompt = `【22:00 次日日练规则】本任务计划每天晚上 22:00 运行。以当前 Asia/Shanghai 时间之前最近一次 22:00 为本轮计划日期；目标学习日是该计划日期的次日。这样跨午夜排队或迟到补跑仍指向正确的一天。下文凡“今天 / 当天 / 今日 / 本日”涉及日练日期、训练日 D、课表星期、文件名、索引行、周五增强和回复日期时，均解释为目标学习日；“昨天 / 上周”依目标学习日计算。先用系统时钟算出目标日期和星期，不覆盖此前已填写的记录。若目标页已存在，只补缺失内容。周五增强应在周四 22:00 为周五页面生成。\n\n${prompt}`;
  } else {
    prompt = `【22:00 备份规则】每天晚上 22:00 运行，排在资料整理和次日日练之后；只提交此刻已经存在的 Obsidian 变更。报告中的“今天”是本次运行的本地日期，不改动原有 Git 范围和禁止 push 的规则。\n\n${prompt}`;
  }
  return `【迁移来源 WorkBuddy：${source.id}】\n${prompt}`;
}

try {
  const sources = sourceIds.map(id => database.query<Source, [string]>("SELECT id,name,prompt,status,rrule,cwds,model_id,push_to_wechat,push_to_wecom_bot,connector_ids_json,skills_json FROM automations WHERE id=? AND deleted_at IS NULL").get(id));
  if (sources.some(value => !value)) throw new Error("A source automation is missing or deleted");
  for (const source of sources as Source[]) {
    if (source.status !== "ACTIVE" || !source.rrule.startsWith("FREQ=DAILY;") || JSON.stringify(JSON.parse(source.cwds)) !== JSON.stringify([workspace]) || source.model_id !== "custom-local:mimo-v2.6-flash" || source.push_to_wechat || source.push_to_wecom_bot || JSON.parse(source.connector_ids_json).length || JSON.parse(source.skills_json).length) throw new Error(`Unsupported WorkBuddy automation: ${source.id}`);
  }
  const projects = new ProjectStore(dataRoot);
  const existing = (await projects.list()).find(item => item.mounts.some(mount => mount.path.toLowerCase() === workspace.toLowerCase()));
  let project = existing ?? await projects.create("Obsidian 学习库");
  if (!existing) project = await projects.mount(project.id, workspace);
  if (project.permissionMode !== "full") project = await projects.setPermission(project.id, "full");
  const mountId = project.mounts.find(item => item.path.toLowerCase() === workspace.toLowerCase())!.id;
  const store = new AutomationStore(dataRoot);
  for (const source of sources as Source[]) {
    const marker = `【迁移来源 WorkBuddy：${source.id}】`;
    const prior = (await store.list()).automations.find(item => item.prompt.startsWith(marker));
    if (prior) {
      if (process.argv.includes("--refresh") && prior.status === "PAUSED") {
        const updated = await store.update(prior.id, { prompt: convertPrompt(source) });
        console.log(`REFRESHED ${source.id} ${updated.id} ${updated.status}`);
      } else console.log(`EXISTS ${source.id} ${prior.id} ${prior.status}`);
      continue;
    }
    const name = source.id === sourceIds[0] ? "晚间整理 · 纪要笔记 + 新文档转换" : source.id === sourceIds[1] ? "次日日练 · 每日综合（含周五重线调度）" : "晚间 Git 备份提交";
    const input: AutomationInput = { name, prompt: convertPrompt(source), kind: "cron", schedule: { kind: "rrule", rule: "FREQ=DAILY;BYHOUR=22;BYMINUTE=0", timeZone: "Asia/Shanghai", startAt: "2026-09-27T14:00:00.000Z" }, modelSelector: "xiaomi-token-plan-cn/mimo-v2.6-flash", projectId: project.id, mountId, notificationPolicy: "all" };
    const item = await store.create(input, "PAUSED");
    console.log(`IMPORTED ${source.id} ${item.id} ${item.status} ${item.nextRunAt}`);
  }
} finally { database.close(); }
