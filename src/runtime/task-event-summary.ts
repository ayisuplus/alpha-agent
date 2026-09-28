import type { PauseReasonCode, StopReasonCode } from "./pause-reasons";
import type { TaskActor, TaskEvent, TaskEventType, WorkerStopReason } from "./task-events";

/**
 * Display projection of the task event log: the durable track of the workbench timeline. The activity log keeps the
 * ephemeral rows (tool calls, streamed text, the person's follow-up questions); everything that changes task state is
 * read from events, so the timeline survives a restart and can be replayed from the log alone.
 */

export interface TaskTimelineEvent {
  seq: number;
  at: string;
  type: TaskEventType;
  /** The run that caused the event, or null when it happened outside one (a workbench action, an import). */
  runId: string | null;
  actor: TaskActor;
  label: string;
  detail?: string;
  tone?: "info" | "success" | "warning" | "danger";
  /** Structured references the workbench joins on, so it never has to parse a label. */
  refs?: {
    criterionId?: string;
    evidenceId?: string;
    passed?: boolean;
    verdict?: string;
    stepId?: string;
    workerId?: string;
    orderId?: string;
    pauseReason?: PauseReasonCode;
    stopReason?: StopReasonCode;
  };
}

const DETAIL_LIMIT = 240;

const PAUSE_LABELS: Record<PauseReasonCode, string> = {
  approval: "等待批准", question: "等待回答", "worker-no-result": "子代理未交结果", sandbox: "沙箱不可用",
  model: "模型不可用", "project-state": "项目状态异常", capability: "能力缺失", budget: "预算用尽",
};

const STOP_LABELS: Record<StopReasonCode, string> = {
  user: "用户停止", model: "模型无响应", sandbox: "沙箱不可用", budget: "预算用尽", error: "运行出错",
  "no-progress": "无实际进展", reconciled: "重启后对账停止",
};

const PHASE_LABELS: Record<string, string> = { plan: "规划中", "plan-review": "计划待审阅", execute: "执行中" };

const STEP_LABELS: Record<string, string> = { planned: "待执行", running: "运行中", complete: "已完成", blocked: "受阻", cancelled: "已取消" };

const WORKER_LABELS: Record<string, string> = {
  queued: "排队中", running: "运行中", returned: "已返回", completed: "已完成", blocked: "等待主代理",
  failed: "失败", cancelled: "已取消",
};

const VERDICT_LABELS: Record<string, string> = { pass: "通过", "changes-requested": "要求修改", inconclusive: "无法判定" };

const WORKER_STOP_LABELS: Record<WorkerStopReason, string> = {
  completed: "已交结果", "needs-input": "等待任务输入", aborted: "已中止", error: "运行出错",
  "max-tokens": "回复超出 token 上限", budget: "预算用尽", refusal: "模型拒绝", "no-result": "未交结果",
};

const MESSAGE_KIND_LABELS: Record<string, string> = { information: "信息", request: "请求", decision: "决定" };

function detail(text: string | undefined | null): string | undefined {
  const value = text?.trim();
  if (!value) return undefined;
  return value.length > DETAIL_LIMIT ? `${value.slice(0, DETAIL_LIMIT)}…` : value;
}

function short(id: string): string {
  return id.slice(0, 8);
}

/** One timeline row per durable event, or null for events that would only add noise to the track. */
export function summarizeTaskEvent(event: TaskEvent): TaskTimelineEvent | null {
  const row = { seq: event.seq, at: event.at, type: event.type, runId: event.runId ?? null, actor: event.actor };
  switch (event.type) {
    case "task/created": return { ...row, label: "任务创建" };
    case "task/imported": return { ...row, label: "导入既有任务" };
    case "contract/revised": return { ...row, label: `目标修订 v${event.payload.contractVersion}`, detail: detail(event.payload.objective), tone: "info" };
    case "criteria/set": return { ...row, label: `验收项更新为 ${event.payload.criteria.map(item => item.id).join("、") || "无"}` };
    case "input/attached": return { ...row, label: `附件 ${event.payload.inputs.length} 个`, detail: detail(event.payload.inputs.map(item => item.name).join("、")) };
    case "capabilities/set": return { ...row, label: `能力已选择（插件 ${event.payload.capabilities.plugins.length}、Skill ${event.payload.capabilities.skills.length}）` };
    case "project-version/confirmed": return { ...row, label: "项目目录已重新检查", tone: "info" };
    case "model/set": return { ...row, label: event.payload.selector ? `模型改为 ${event.payload.selector}` : "模型改回工作台默认" };
    case "guidance/recorded": return { ...row, label: "用户补充", detail: detail(event.payload.guidance.instruction), tone: "info" };
    case "goal/changed": return { ...row, label: event.payload.goal.enabled ? "持续推进已开启" : "持续推进已关闭", detail: detail(event.payload.goal.stopReason ? `停止原因：${event.payload.goal.stopReason}` : undefined) };
    case "phase/changed": return { ...row, label: `阶段：${PHASE_LABELS[event.payload.phase] ?? event.payload.phase}`, tone: "info" };
    case "plan/submitted": return { ...row, label: "计划已提交审阅", tone: "info" };
    case "plan/approved": return { ...row, label: "计划已批准，开始执行", tone: "success" };
    case "plan/revised": return { ...row, label: "计划已修订", detail: detail(event.payload.input.summary), tone: "info" };
    case "step/changed": return { ...row, label: `步骤 ${event.payload.id}：${STEP_LABELS[event.payload.status] ?? event.payload.status}`, detail: detail(event.payload.reason), refs: { stepId: event.payload.id } };
    case "capability-gap/recorded": return { ...row, label: "能力缺口", detail: detail(event.payload.description), tone: "warning" };
    case "capability-gap/resolved": return { ...row, label: "能力缺口已解决", detail: detail(event.payload.resolution), tone: "success" };
    case "skill-search/recorded": return { ...row, label: `Skill 检索 ${event.payload.key}（${event.payload.resultCount} 个结果）`, detail: detail(event.payload.error) };
    case "skill-proposal/decided": return { ...row, label: event.payload.decision === "installed" ? `Skill 已安装：${event.payload.installedSkillId ?? ""}` : "Skill 提案已拒绝", tone: event.payload.decision === "installed" ? "success" : "info" };
    case "evidence/recorded": return { ...row, label: `证据 ${event.payload.evidence.criterionId} ${event.payload.evidence.passed ? "通过" : "未通过"}`, detail: detail(event.payload.evidence.source), tone: event.payload.evidence.passed ? "success" : "warning", refs: { criterionId: event.payload.evidence.criterionId, evidenceId: event.payload.evidence.id, passed: event.payload.evidence.passed } };
    case "preview/published": return { ...row, label: "本机预览已发布", detail: detail(event.payload.preview.url) };
    case "run/ended": return {
      ...row,
      label: `运行结束 · ${event.payload.run.stage ?? "coordinator"} · ${event.payload.run.outcome}`,
      detail: detail([event.payload.run.failureReason, event.payload.run.firstResponseMs === undefined ? "" : `${event.payload.run.firstResponseMs}ms 到首响应`].filter(Boolean).join("；")),
      tone: event.payload.run.outcome === "returned" ? "info" : "warning",
    };
    case "step/context": return {
      ...row,
      label: `模型上下文 · ${event.payload.stage} · ${Math.round((event.payload.systemTokens + event.payload.toolTokens) / 100) / 10}k tokens`,
      detail: detail(`任务块 ${event.payload.taskContextBytes} 字节 · ${event.payload.toolNames.length} 个工具 · ${event.payload.model}`),
      tone: "info",
    };
    case "source/revision-refreshed": return { ...row, label: "源码已更新，旧证据失效", tone: "info" };
    case "failure/recorded": return { ...row, label: "运行失败", detail: detail(event.payload.reason), tone: "danger" };
    case "development/enabled": return { ...row, label: "独立审查已启用" };
    case "review/recorded": return { ...row, label: `独立审查：${VERDICT_LABELS[event.payload.review.verdict] ?? event.payload.review.verdict}`, detail: detail(event.payload.review.findings.join("；")), tone: event.payload.review.verdict === "pass" ? "success" : "warning", refs: { verdict: event.payload.review.verdict, passed: event.payload.review.verdict === "pass" } };
    case "repair-attempt/recorded": return { ...row, label: "按审查意见修复", tone: "info" };
    case "worker/dispatched": return { ...row, label: `子实例 ${event.payload.orderId} 已派发`, detail: detail(event.payload.decisionReason), refs: { workerId: event.payload.id, orderId: event.payload.orderId } };
    case "worker/queued": return { ...row, label: `子实例 ${event.payload.order.id} 排队中`, detail: detail(event.payload.order.objective), refs: { workerId: event.payload.attemptId, orderId: event.payload.order.id } };
    case "worker/updated": return { ...row, label: `子实例 ${short(event.payload.id)}：${WORKER_LABELS[event.payload.status] ?? event.payload.status}`, detail: detail(event.payload.patch.findings?.join("；")), tone: event.payload.status === "completed" ? "success" : event.payload.status === "failed" ? "danger" : "info", refs: { workerId: event.payload.id } };
    case "worker-receipt/recorded": return { ...row, label: `检查回执 ${event.payload.receipt.passed ? "通过" : "未通过"}`, detail: detail(event.payload.receipt.path), tone: event.payload.receipt.passed ? "success" : "warning" };
    case "worker-request/recorded": return { ...row, label: `子代理请求：${event.payload.request.kind}`, detail: detail(event.payload.request.blockedStep), tone: "warning" };
    case "worker-request/updated": return { ...row, label: `子代理请求 ${event.payload.patch.status}`, detail: detail(event.payload.patch.reason) };
    case "worker/finished": return { ...row, label: `子实例 ${short(event.payload.id)}：${WORKER_LABELS[event.payload.status] ?? event.payload.status}`, detail: detail(event.payload.findings.join("；")), tone: event.payload.status === "completed" ? "success" : "warning", refs: { workerId: event.payload.id } };
    case "workers/reconciled": return { ...row, label: "子实例已对账", detail: detail(event.payload.reason), tone: "warning" };
    case "worker-outcome/recorded": return { ...row, label: `子代理结果：${event.payload.outcome.status}`, detail: detail(event.payload.outcome.findings.join("；")) };
    case "worker/activated": return { ...row, label: `子实例 ${short(event.payload.attemptId)} 已启动`, detail: detail(event.payload.worktreePath ?? event.payload.workRoot), refs: { workerId: event.payload.attemptId, orderId: event.payload.orderId } };
    case "worker/result": return {
      ...row,
      label: `子实例 ${short(event.payload.attemptId)} ${WORKER_STOP_LABELS[event.payload.stopReason]}`,
      detail: detail(event.payload.findings.join("；") || event.payload.detail),
      tone: event.payload.stopReason === "completed" ? "success" : event.payload.stopReason === "no-result" || event.payload.stopReason === "error" ? "danger" : "warning",
      refs: { workerId: event.payload.attemptId, ...(event.payload.reviewVerdict ? { verdict: event.payload.reviewVerdict } : {}) },
    };
    case "worker/message-queued": return { ...row, label: `消息 → ${event.payload.message.toAgentId ? `子代理 ${short(event.payload.message.toAgentId)}` : "主代理"} · ${MESSAGE_KIND_LABELS[event.payload.message.kind] ?? event.payload.message.kind}`, detail: detail(event.payload.message.body), tone: event.payload.message.kind === "request" ? "warning" : "info" };
    case "status/changed": {
      if (event.payload.status === "complete") return { ...row, label: "已验收", tone: "success" };
      if (event.payload.status === "stopped") return { ...row, label: `已停止：${STOP_LABELS[event.payload.reason]}`, detail: detail(event.payload.detail), tone: "warning", refs: { stopReason: event.payload.reason } };
      if (event.payload.status === "needs-input") return { ...row, label: `需要回答：${event.payload.reason ? PAUSE_LABELS[event.payload.reason] : "等待输入"}`, detail: detail(event.payload.question), tone: "warning", refs: { pauseReason: event.payload.reason } };
      return { ...row, label: event.payload.guidance ? "已恢复运行" : "已重新打开", detail: detail(event.payload.reopenReason), tone: "info" };
    }
    case "checkpoint/started": return { ...row, label: "自动提交进行中" };
    case "checkpoint/committed": return { ...row, label: "检查点已提交", tone: "success" };
    case "checkpoint/failed": return { ...row, label: "自动提交失败", detail: detail(event.payload.reason), tone: "danger" };
    case "operation/started": return { ...row, label: "运行已登记", tone: "info" };
    case "approval/requested": return { ...row, label: `待批准：${event.payload.purpose}`, detail: detail([...(event.payload.argv ?? []), ...(event.payload.exactAction ? [event.payload.exactAction] : [])].join(" ") || event.payload.reason), tone: "warning" };
    case "approval/reviewed": return { ...row, label: `审批：${event.payload.decision === "approved" ? "已批准" : event.payload.decision === "denied" ? "已拒绝" : "待人工决定"}`, detail: detail(event.payload.reason), tone: event.payload.decision === "approved" ? "success" : "warning" };
    case "approval/finished": return { ...row, label: `审批动作完成 · 退出码 ${event.payload.exitCode}`, detail: detail(event.payload.logPath), tone: event.payload.exitCode === 0 ? "success" : "warning" };
    case "web-approval/requested": return { ...row, label: `网页授权待批：${event.payload.scope}`, detail: detail(event.payload.kind), tone: "warning" };
    case "web-approval/decided": return { ...row, label: `网页授权：${event.payload.approved ? "已批准" : "已拒绝"}`, tone: event.payload.approved ? "success" : "warning" };
    case "web-approval/read-granted": return { ...row, label: `网页只读授权：${event.payload.scope}`, tone: "success" };
    case "web-approval/write-finished": return { ...row, label: event.payload.uncertain ? "网页写入结果不确定" : "网页写入完成", tone: event.payload.uncertain ? "warning" : "success" };
    // Pure bookkeeping: no value on the timeline.
    case "operation/finished":
    case "approval/claimed":
    case "web-approval/write-begun":
    case "web-approval/reconciled":
    case "guidance/status-changed":
    case "candidates/set":
    case "failure/cleared":
    case "worker-cognition/updated":
    case "worker-run/prepared":
    case "worker/message-acknowledged":
      return null;
    // No default: the switch must stay exhaustive, so a new event type fails to compile until it is classified here.
  }
}

export function summarizeTaskEvents(events: readonly TaskEvent[]): TaskTimelineEvent[] {
  const rows: TaskTimelineEvent[] = [];
  for (const event of events) {
    const row = summarizeTaskEvent(event);
    if (row) rows.push(row);
  }
  return rows;
}
