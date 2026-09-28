import { PAUSE_REASONS, isPauseReasonCode, isStopReasonCode } from "./pause-reasons";
import { computeCompletionGaps } from "./task-completion";
import type { TaskState } from "./task-ledger";

/**
 * Executable form of the invariants in docs/cognitive-state-machine-plan-2026-09-28.md §4.6.
 * Pure over a task state so the same checks run on live ledgers, on copies during characterization,
 * and (from P1 on) inside the event fold after every append.
 */

/** Invariant families, numbered as in the plan; `S` is state coherence beyond the plan's first batch. */
export type InvariantFamily = "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "S";

export interface InvariantViolation {
  /** Stable error code, e.g. `I6/needs-input-without-reason-code`. Never renumbered; new checks add new codes. */
  code: string;
  invariant: InvariantFamily;
  message: string;
}

export interface TaskOperationRecord {
  taskId: string;
  runId: string;
  status: "running" | "finished";
}

/**
 * The eight reason codes of plan §4.4. Before P2 this list held the sixteen free-text service names that producers
 * passed to `needInput`; `LEGACY_SERVICE_TO_REASON` in `pause-reasons.ts` is the migration table for imported ledgers.
 */
export const KNOWN_PAUSE_REASONS = PAUSE_REASONS;

/** Invariants that a mutable ledger snapshot cannot express; they become checkable once the event log exists. */
export const UNCHECKABLE_INVARIANTS: Array<{ code: string; reason: string }> = [
  { code: "I1", reason: "序号连续性需要只追加事件日志；账本快照没有 seq" },
  { code: "I2/partial", reason: "快照只能看到操作日志残留的进行中记录，看不到运行期间的并发写入" },
];

/** Worker attempt statuses meaning the attempt ended; static membership table. */
const FINISHED_INSTANCE: Record<string, true> = { completed: true, blocked: true, failed: true, cancelled: true };

export function checkTaskInvariants(state: TaskState, operations: TaskOperationRecord[] = []): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const add = (code: string, invariant: InvariantFamily, message: string) => violations.push({ code, invariant, message });
  const contractVersion = state.contractVersion ?? 1;
  const cognition = state.cognition;
  const instances = cognition?.instances ?? [];

  // I2 — one in-progress run per task, matching the operation manager's lock.
  for (const operation of operations.filter(item => item.taskId === state.id && item.status === "running")) {
    if (state.status !== "active") add("I2/stale-operation-lock", "I2", `操作日志仍标记运行中（run ${operation.runId}），但任务状态是 ${state.status}`);
  }

  // I3 — complete requires current passing evidence for every criterion and nothing awaiting integration.
  if (state.status === "complete") {
    const gaps = computeCompletionGaps(state);
    if (gaps.length) add("I3/complete-without-current-evidence", "I3", `任务已完成但验收缺口未闭合：${gaps.join(", ")}`);
  }

  // I4 — contract versions increase by one and no record comes from a future contract.
  const history = state.contractHistory ?? [];
  for (const [index, entry] of history.entries()) {
    if (index > 0 && entry.version <= history[index - 1].version) add("I4/contract-history-not-monotonic", "I4", `契约历史版本倒退：${history[index - 1].version} → ${entry.version}`);
    if (entry.version >= contractVersion) add("I4/contract-history-not-past", "I4", `契约历史包含当前或未来版本 ${entry.version}（当前 ${contractVersion}）`);
  }
  if (history.length && history[history.length - 1].version + 1 !== contractVersion) {
    add("I4/contract-version-gap", "I4", `契约版本从 ${history[history.length - 1].version} 跳到 ${contractVersion}`);
  }
  if (history.length !== contractVersion - 1) {
    add("I4/contract-history-incomplete", "I4", `契约版本 ${contractVersion} 应有 ${contractVersion - 1} 条修订历史，实际 ${history.length} 条`);
  }
  for (const evidence of state.evidence.filter(item => (item.contractVersion ?? 1) > contractVersion)) {
    add("I4/evidence-from-future-contract", "I4", `证据 ${evidence.id} 属于契约版本 ${evidence.contractVersion}，当前是 ${contractVersion}`);
  }
  for (const run of (state.runs ?? []).filter(item => (item.contractVersion ?? 1) > contractVersion)) {
    add("I4/run-from-future-contract", "I4", `运行记录（${run.recordedAt}）属于契约版本 ${run.contractVersion}，当前是 ${contractVersion}`);
  }

  // I5 — worker results come from activated workers, integration only after a result.
  for (const request of state.workerRequests ?? []) {
    if (!instances.some(item => item.id === request.runId && item.agentId === request.agentId)) {
      add("I5/worker-request-without-instance", "I5", `子代理请求 ${request.id} 指向不存在的实例 ${request.runId}（agent ${request.agentId}）`);
    }
  }
  for (const instance of instances) {
    // "returned" already carries the worker's result, so a pending or recorded integration decision is legitimate there.
    if ((instance.integration || instance.integrationDecision) && !FINISHED_INSTANCE[instance.status] && instance.status !== "returned") {
      add("I5/integration-without-result", "I5", `实例 ${instance.id} 尚未返回结果（状态 ${instance.status}）却已有集成结论`);
    }
    if (instance.cognitionRevision > (cognition?.revision ?? 1)) {
      add("I7/instance-ahead-of-cognition", "I7", `实例 ${instance.id} 记录认知修订 ${instance.cognitionRevision}，账本只有 ${cognition?.revision ?? 1}`);
    }
  }
  for (const agent of cognition?.agents ?? []) {
    const attempt = instances.find(item => item.id === agent.lastAttemptId);
    if (!attempt) add("I5/agent-attempt-unknown", "I5", `子代理 ${agent.id} 的最新尝试 ${agent.lastAttemptId} 不在实例记录中`);
    else {
      const expected = attempt.status === "blocked" ? "waiting-primary" : attempt.status;
      if (agent.status !== expected) add("I5/agent-status-mismatch", "I5", `子代理 ${agent.id} 状态 ${agent.status} 与其尝试状态 ${attempt.status} 不一致（应为 ${expected}）`);
    }
  }
  const review = state.development?.review;
  if (review && !instances.some(item => item.id === review.instanceId)) {
    add("I5/review-without-instance", "I5", `开发审查引用不存在的实例 ${review.instanceId}`);
  }

  // I6 — every pause carries a reason code, every stop records its cause, and no other status keeps those fields.
  if (state.status === "needs-input") {
    if (!state.pendingQuestion?.trim()) add("I6/needs-input-without-question", "I6", "任务等待输入但没有待回答问题");
    if (!state.pauseReason) add("I6/needs-input-without-reason-code", "I6", `任务等待输入但没有原因码：${state.pendingQuestion?.trim() ?? ""}`);
    else if (!isPauseReasonCode(state.pauseReason)) add("I6/unknown-reason-code", "I6", `未知暂停原因码 ${String(state.pauseReason)}`);
  } else if (state.pendingQuestion || state.pauseReason) {
    add("S/leftover-pause-fields", "S", `任务状态为 ${state.status}，却仍保留暂停字段（问题：${state.pendingQuestion ?? "无"}；原因码：${state.pauseReason ?? "无"}）`);
  }
  if (state.stop && !isStopReasonCode(state.stop.reason)) add("I6/unknown-stop-reason", "I6", `未知停止原因码 ${String(state.stop.reason)}`);
  if (state.status !== "stopped" && state.stop) add("S/leftover-stop-record", "S", `任务状态为 ${state.status}，却保留停止记录（${state.stop.reason}）`);

  // I7 — revisions only move forward and match the phase they belong to.
  let previousAmendment = 0;
  for (const amendment of cognition?.amendments ?? []) {
    if (amendment.revision <= previousAmendment) add("I7/amendment-revision-not-monotonic", "I7", `认知修订记录倒退：${previousAmendment} → ${amendment.revision}`);
    if (amendment.revision > (cognition?.revision ?? 1)) add("I7/amendment-ahead-of-cognition", "I7", `认知修订记录 ${amendment.revision} 超过当前修订 ${cognition?.revision ?? 1}`);
    previousAmendment = amendment.revision;
  }
  if (state.planApproval) {
    if (state.phase !== "execute") add("I7/plan-approval-phase-mismatch", "I7", `计划已批准（阶段 ${state.phase ?? "execute"}）但阶段不是 execute`);
    if (state.planApproval.cognitionRevision > (cognition?.revision ?? 1)) {
      add("I7/plan-approval-ahead-of-cognition", "I7", `计划批准引用认知修订 ${state.planApproval.cognitionRevision}，账本只有 ${cognition?.revision ?? 1}`);
    }
    if (state.planApproval.contractVersion !== contractVersion) {
      add("I7/plan-approval-contract-mismatch", "I7", `计划批准属于契约版本 ${state.planApproval.contractVersion}，当前是 ${contractVersion}`);
    }
  }
  if ((state.goal?.noProgressRuns ?? 0) < 0) add("I7/negative-no-progress-runs", "I7", `无进展轮数为 ${state.goal?.noProgressRuns}`);
  for (const step of cognition?.steps ?? []) {
    if (step.revision !== undefined && step.revision < 0) add("I7/step-revision-negative", "I7", `计划步骤 ${step.id} 的看板修订为负数：${step.revision}`);
  }

  // S — coherence the transition table will guarantee from P2 on.
  if (state.status === "complete" && state.lastFailure) add("S/complete-with-failure", "S", `任务已完成但保留失败原因：${state.lastFailure}`);
  if (state.status === "stopped" && !state.stop && !state.lastFailure && !state.reopenReason && !state.goal?.stopReason) {
    add("S/stopped-without-reason", "S", "任务已停止但没有停止原因（stop / lastFailure / reopenReason / goal.stopReason 都为空）");
  }
  const steps = cognition?.steps ?? [];
  for (const step of steps) {
    // A restart reconciles the instance but leaves the step running; a claim naming that ended instance explains it.
    if (step.status === "running"
      && !instances.some(item => item.orderId === step.id && !FINISHED_INSTANCE[item.status])
      && !instances.some(item => item.id === step.claimedBy && FINISHED_INSTANCE[item.status])) {
      add("S/step-running-without-instance", "S", `计划步骤 ${step.id} 标记运行中，但没有未结束的实例`);
    }
    if (step.status === "complete" && step.dependsOn.some(dependency => steps.find(item => item.id === dependency)?.status !== "complete")) {
      add("S/step-complete-with-unmet-dependency", "S", `计划步骤 ${step.id} 已完成，但依赖未全部完成`);
    }
  }
  return violations;
}
