import type { ActivityEntry, ReviewSummary, TaskView } from "../api/types";
import { criterionLabel, taskStatus, taskTitle } from "./labels";
import { buildTimeline } from "./timeline";

const TURN_NAMES = { create: "创建", revise: "修订", resume: "构建或修复", ask: "回答追问", publish: "发布预览", verify: "浏览器验收", other: "操作" };

export function buildTaskReport(task: TaskView, activity: ActivityEntry[], reviews: ReviewSummary[]): string {
  const lines = [
    `# ${taskTitle(task)}`,
    "",
    `- 任务 ID：${task.id}`,
    `- 状态：${taskStatus(task).label}`,
    `- 创建于：${task.createdAt ?? "未知"}`,
    `- 更新于：${task.updatedAt}`,
    `- 产品目录：${task.projectRoot ?? "未知"}`,
    "",
    "## 目标",
    "",
  ];
  const history = task.contractHistory ?? [];
  for (let version = 1; version <= task.contractVersion; version++) {
    const objective = version === task.contractVersion ? task.objective : history.find(item => item.version === version)?.objective;
    if (objective) lines.push(`### v${version}${version === task.contractVersion ? "（当前）" : ""}`, "", objective, "");
  }

  lines.push("## 执行记录", "");
  const turns = buildTimeline({ task, activity, reviews, busy: task.running }).filter(item => item.type === "turn");
  if (!turns.length) lines.push("暂无可追溯的执行记录。", "");
  for (const turn of turns) {
    lines.push(`### 第 ${turn.index} 轮 · ${TURN_NAMES[turn.kind]}`, "", `- 时间：${turn.startedAt}`, `- 结果：${turn.outcome ?? (turn.live ? "运行中" : "未记录")}`,
      `- 模型：${turn.models.join("、") || "未记录"}`, `- 工具调用：${turn.toolCount} 次`);
    if (turn.review?.paths.length) lines.push(`- 改动文件：${turn.review.paths.join("、")}`);
    lines.push("");
  }

  lines.push("## 验收", "");
  for (const criterion of task.criteria) {
    const evidence = task.evidence.findLast(item => item.criterionId === criterion.id);
    const result = evidence ? `${evidence.passed ? "通过" : "失败"}${evidence.current ? "（当前）" : "（已过期）"}` : "无证据";
    lines.push(`- ${criterionLabel(criterion.id, task.criteria)}：${result}${evidence ? `；${evidence.recordedAt}；${evidence.source}` : ""}`);
  }
  lines.push(`- 本机预览：${task.preview?.url ?? "无"}${task.preview && !task.preview.live ? "（已停止）" : ""}`, "");

  lines.push("## 源码改动", "");
  const paths = [...new Set(reviews.flatMap(review => review.paths))].sort();
  if (paths.length) lines.push(...paths.map(path => `- ${path}`));
  else lines.push("暂无源码快照记录。");
  return `${lines.join("\n")}\n`;
}
