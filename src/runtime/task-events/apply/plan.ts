import { refreshReady } from "./graph";
import type { ExpertDecision, PlanNode, PlanNodeKind, PlanNodeStatus, TaskState, TemporaryExpert } from "../../task-ledger";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/** Plan family: plan submission/approval/revision, node board updates, candidates, capability gaps, skill proposals. */

/** Tools every worker already has; a proposal requiring anything else is blocked (see `decideSkillProposal`). */
const WORKER_TOOLS: Record<string, true> = { read: true, grep: true, edit: true, write: true, alpha_build: true, alpha_worker_result: true };

const KIND_BY_LEGACY: Record<string, PlanNodeKind> = { investigate: "investigate", execute: "execute", implement: "execute", review: "review" };
const LEGACY_STATUS: Record<string, PlanNodeStatus> = { planned: "planned", ready: "ready", reopened: "reopened", running: "active", active: "active", blocked: "waiting", waiting: "waiting", complete: "done", done: "done", cancelled: "cancelled" };

/** `assertActive` lives in every reducer whose ledger method had it, so a fold rejects the same events. */
function assertActive(state: TaskState): void {
  if (state.status !== "active") throw new InvariantError("apply/task-not-active", `Task is ${state.status}`);
}

/**
 * Logs from before the plan-graph vocabulary carry `mode` steps without stages or expert decisions; those read as
 * execute-stage nodes (§8 旧任务: implement maps to execute, investigate and review keep their kind).
 */
export function normalizePlanNode(value: unknown): PlanNode {
  if (!value || typeof value !== "object") throw new InvariantError("apply/cognition-steps-invalid", "认知节点无效");
  const raw = value as Record<string, unknown>; // narrowed to an object above; fields are validated as they are read
  const kind = KIND_BY_LEGACY[String(raw.kind ?? raw.mode)];
  if (!kind) throw new InvariantError("apply/cognition-steps-invalid", "认知节点类型无效");
  const legacy = !("kind" in raw);
  const decision = raw.expertDecision as { expertId?: unknown; temporaryExpert?: unknown; reason?: unknown } | undefined; // legacy payloads carry no decision
  const legacyExpert = typeof raw.expertId === "string" ? raw.expertId : undefined;
  const expertDecision: ExpertDecision = {
    ...(typeof decision?.expertId === "string" ? { expertId: decision.expertId } : typeof decision?.expertId === "undefined" && legacyExpert ? { expertId: legacyExpert } : {}),
    ...(decision?.temporaryExpert ? { temporaryExpert: decision.temporaryExpert as TemporaryExpert } : {}),
    reason: typeof decision?.reason === "string" ? decision.reason : "历史计划（旧格式步骤）",
  };
  const phase = legacy ? "execute" : raw.phase as PlanNodeKind;
  if (!KIND_BY_LEGACY[String(phase)]) throw new InvariantError("apply/cognition-steps-invalid", "认知节点阶段无效");
  return {
    id: String(raw.id ?? ""), kind, phase, objective: String(raw.objective ?? ""),
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
    expertDecision,
    host: raw.host === "worker" ? "worker" : "coordinator",
    ...(Array.isArray(raw.consumes) ? { consumes: raw.consumes.map(String) } : {}),
    ...(Array.isArray(raw.produces) ? { produces: raw.produces.map(String) } : {}),
    ...(Array.isArray(raw.ownedPaths) ? { ownedPaths: raw.ownedPaths.map(String) } : {}),
    ...(typeof raw.gateRole === "string" ? { gateRole: raw.gateRole } : {}),
    skillIds: Array.isArray(raw.skillIds) ? raw.skillIds.map(String) : [],
    status: LEGACY_STATUS[String(raw.status)] ?? "planned",
    ...(typeof raw.statusReason === "string" ? { statusReason: raw.statusReason } : {}),
    ...(typeof raw.revision === "number" ? { revision: raw.revision } : {}),
    ...(typeof raw.claimedBy === "string" ? { claimedBy: raw.claimedBy } : {}),
    ...(raw.handoff ? { handoff: raw.handoff as PlanNode["handoff"] } : {}),
    ...(raw.activation ? { activation: raw.activation as PlanNode["activation"] } : {}),
  };
}

const nodeDefinition = (node: PlanNode) => JSON.stringify([node.objective, node.kind, node.phase, node.expertDecision, node.dependsOn, node.skillIds, node.host]);

export const planReducers: FamilyReducers = {
  "plan/submitted": (state) => {
    if (state.phase !== "plan" || !state.cognition?.nodes.length) throw new InvariantError("apply/plan-empty", "A nonempty plan is required for review");
    if (state.cognition.basedOnRevision !== state.revision) throw new InvariantError("apply/plan-source-moved", "Project changed after planning; review the current source and revise the plan");
    state.phase = "plan-review";
  },

  // The `fingerprintSource` check stays in the ledger method; everything else the approval compares is here.
  "plan/approved": (state, event) => {
    const approval = event.payload.approval;
    if (state.phase !== "plan-review" || state.status !== "active") throw new InvariantError("apply/no-plan-awaiting-review", "Task has no plan awaiting review");
    if (approval.contractVersion !== (state.contractVersion ?? 1) || approval.cognitionRevision !== state.cognition?.revision || approval.sourceRevision !== state.revision) {
      throw new InvariantError("apply/plan-approval-stale", "Plan or project changed; review the current version before executing");
    }
    const { contractVersion, cognitionRevision, sourceRevision, approvedAt } = approval;
    state.planApproval = { contractVersion, cognitionRevision, sourceRevision, approvedAt };
    state.phase = "execute";
    if (state.goal) { state.goal.stopReason = undefined; state.goal.noProgressRuns = 0; }
  },

  "plan/revised": (state, event) => {
    assertActive(state);
    // B3 (§3.7 护栏): three revisions with no finished node in between mean re-planning is going in circles; the fourth
    // is refused here and the tool turns the refusal into a pause for the user.
    const stall = state.cognition?.planStallRevisions ?? 0;
    if (stall >= 3) throw new InvariantError("apply/plan-stall-revision", "计划修订过于频繁：三轮修订没有任何节点完成。先完成已就绪的节点并用 alpha_step 退出，或用 alpha_reopen 退回前提有误的节点；要大幅改计划就停下来等用户决定。");
    const input = event.payload.input;
    const legacyInput = !("nodes" in input);
    const rawNodes: unknown[] = !legacyInput && Array.isArray(input.nodes) ? input.nodes : "steps" in input && Array.isArray(input.steps) ? input.steps : [];
    const nodes = rawNodes.map(normalizePlanNode);
    if (!input.summary.trim() || !input.reason.trim() || nodes.length > 20) throw new InvariantError("apply/cognition-content-invalid", "认知修订内容无效");
    const ids = new Set(nodes.map(node => node.id));
    if (ids.size !== nodes.length || nodes.some(node => !/^[a-z][a-z0-9-]{0,31}$/.test(node.id) || ["coordinator", "final-review", "review-repair"].includes(node.id) || !node.objective.trim() || node.dependsOn.some(id => !ids.has(id) || id === node.id))) throw new InvariantError("apply/cognition-steps-invalid", "认知节点无效");
    // §3.2: the three stages run in order, so a dependency may never point forward past the node's own stage — an
    // execute node that depends on a review node would deadlock against the stage gate. Such returns are declared as
    // rework/premise back-edges instead.
    const stageOrder: PlanNodeKind[] = ["investigate", "execute", "review"];
    for (const node of nodes) {
      for (const dependency of node.dependsOn) {
        const target = nodes.find(item => item.id === dependency);
        if (target && stageOrder.indexOf(target.phase) > stageOrder.indexOf(node.phase)) throw new InvariantError("apply/plan-stage-order", `依赖不能跨阶段倒挂：${node.id}（${node.phase}）依赖 ${dependency}（${target.phase}）；需要退回时用 rework/premise 回边`);
      }
    }
    for (const node of nodes) {
      if (!node.expertDecision.reason.trim()) throw new InvariantError("apply/expert-decision-required", `节点必须写明专家决定与理由：${node.id}`);
      if (node.expertDecision.expertId && node.expertDecision.temporaryExpert) throw new InvariantError("apply/expert-decision-required", `节点的专家决定只能选一种：${node.id}`);
      if (node.gateRole && node.kind !== "review") throw new InvariantError("apply/gate-role-not-review", `gateRole 只能用于审查节点：${node.id}`);
    }
    const edges = input.edges ?? [];
    for (const edge of edges) {
      if (edge.kind !== "rework" && edge.kind !== "premise") throw new InvariantError("apply/edge-invalid", `回边类型无效：${edge.kind}`);
      if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) throw new InvariantError("apply/edge-invalid", `回边端点无效：${edge.from} → ${edge.to}`);
      const from = nodes.find(node => node.id === edge.from)!;
      const to = nodes.find(node => node.id === edge.to)!;
      if (edge.kind === "rework" && (from.kind !== "review" || to.kind !== "execute")) throw new InvariantError("apply/edge-invalid", "rework 回边必须从审查节点指向执行节点");
      if (edge.kind === "premise" && to.kind !== "investigate") throw new InvariantError("apply/edge-invalid", "premise 回边必须指向调查节点");
      if (edge.maxTraversals !== undefined && (!Number.isInteger(edge.maxTraversals) || edge.maxTraversals < 1)) throw new InvariantError("apply/edge-invalid", "回边次数上限必须是正整数");
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(nodes.map(node => [node.id, node]));
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new InvariantError("apply/cognition-cycle", "认知节点存在循环依赖");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
    const previous = state.cognition ?? { revision: 0, recipeVersion: 1, summary: state.objective, candidates: [], nodes: [], gaps: [], amendments: [] };
    if (state.designatedExpertId && (!input.candidates.includes(state.designatedExpertId) || (nodes.length > 0 && !nodes.some(node => node.expertDecision.expertId === state.designatedExpertId)))) throw new InvariantError("apply/designated-expert-dropped", `用户指定专家必须保留在计划中：${state.designatedExpertId}`);
    // Entered, claimed or finished nodes are immutable (§3.7); un-entered ones may change or be cancelled.
    for (const prior of previous.nodes.filter(node => node.status === "active" || node.status === "waiting" || node.status === "done" || node.claimedBy !== undefined)) {
      const next = nodes.find(node => node.id === prior.id);
      if (!next || nodeDefinition(next) !== nodeDefinition(prior)) throw new InvariantError("apply/dispatched-step-rewritten", `已进入或完成的节点不可改写：${prior.id}`);
    }
    for (const prior of previous.nodes) {
      if (nodes.some(node => node.id === prior.id)) continue;
      nodes.push({ ...prior, status: "cancelled" });
    }
    // The skeleton's three stages each need at least one live node (§3.2); legacy plans predate stages and skip this.
    // Checked last so structural errors (cycles, rewrites, dropped experts) report themselves instead of being masked.
    if (!legacyInput && (["investigate", "execute", "review"] as PlanNodeKind[]).some(stage => !nodes.some(node => node.phase === stage && node.status !== "cancelled"))) throw new InvariantError("apply/plan-stage-empty", "调查、执行、审查三个阶段都必须至少有一个节点");
    const revision = previous.revision + 1;
    const clean = (values: string[] | undefined, fallback: string[] | undefined) => values === undefined ? fallback : [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 20);
    const nextScope = clean(input.scope, previous.scope);
    const nextConstraints = clean(input.constraints, previous.constraints);
    const materialChange = !!state.planApproval && (JSON.stringify(nextScope) !== JSON.stringify(previous.scope) || JSON.stringify(nextConstraints) !== JSON.stringify(previous.constraints) || nodes.some(node => !previous.nodes.some(prior => prior.id === node.id && prior.status !== "cancelled")) || previous.nodes.some(prior => prior.status !== "done" && prior.status !== "active" && prior.status !== "cancelled" && !nodes.some(node => node.id === prior.id && nodeDefinition(node) === nodeDefinition(prior))));
    state.cognition = { ...previous, revision, planStallRevisions: stall + 1, basedOnRevision: state.revision, summary: input.summary.trim(), scope: nextScope, constraints: nextConstraints, openQuestions: clean(input.openQuestions, previous.openQuestions), candidates: [...new Set(input.candidates)], nodes: nodes.map(node => {
      const prior = previous.nodes.find(item => item.id === node.id);
      return prior ? { ...node, status: prior.status, statusReason: prior.statusReason, revision: prior.revision, claimedBy: prior.claimedBy, activation: prior.activation, handoff: prior.handoff, stale: prior.stale } : node;
    }), edges: input.edges === undefined ? previous.edges ?? [] : edges.map(edge => {
      const prior = previous.edges?.find(item => item.from === edge.from && item.to === edge.to && item.kind === edge.kind);
      return { ...edge, ...(prior?.traversals !== undefined ? { traversals: prior.traversals } : {}) };
    }), amendments: [...previous.amendments, { revision, reason: input.reason.trim(), affectedNodes: nodes.map(node => node.id), recordedAt: event.payload.recordedAt }] };
    if (materialChange) { state.phase = "plan-review"; delete state.planApproval; }
    refreshReady(state);
  },

  /** Legacy board updates; folds map the old statuses onto the node lifecycle (§8). */
  "step/changed": (state, event) => {
    const { id, status, reason, expectedRevision, claimedBy } = event.payload;
    assertActive(state);
    const node = state.cognition?.nodes.find(item => item.id === id);
    if (!node || !reason.trim()) throw new InvariantError("apply/step-required", "Step and reason are required");
    if (expectedRevision !== undefined && expectedRevision !== (node.revision ?? 0)) throw new InvariantError("apply/step-revision-conflict", `Step ${id} moved on: expected revision ${expectedRevision}, found ${node.revision ?? 0}`);
    if (node.status === "done" || node.status === "cancelled") throw new InvariantError("apply/step-finished", "Finished step cannot be rewritten");
    if (state.cognition?.instances?.some(instance => instance.orderId === id)) throw new InvariantError("apply/step-delegated", "Delegated step status is owned by the work order result");
    if (state.phase === "plan" && node.kind !== "investigate") throw new InvariantError("apply/step-plan-mode", "Planning can only finish investigation steps");
    if (state.phase === "plan-review") throw new InvariantError("apply/plan-awaiting-review", "Plan is awaiting review");
    if (status === "complete" && node.dependsOn.some(dep => state.cognition?.nodes.find(item => item.id === dep)?.status !== "done")) throw new InvariantError("apply/step-deps-incomplete", "Step dependencies are not complete");
    node.status = LEGACY_STATUS[status] ?? "planned";
    node.statusReason = reason.trim();
    node.revision = (node.revision ?? 0) + 1;
    if (claimedBy !== undefined) node.claimedBy = claimedBy;
    refreshReady(state);
  },

  "candidates/set": (state, event) => {
    const ids = event.payload.candidates;
    const cognition = state.cognition;
    if (!cognition || cognition.revision !== 1 || cognition.candidates.length || (!ids.length && !state.designatedExpertId)) return;
    cognition.candidates = [...new Set([...(state.designatedExpertId ? [state.designatedExpertId] : []), ...ids])].slice(0, 3);
  },

  "capability-gap/recorded": (state, event) => {
    const { kind, description, recordedAt } = event.payload;
    assertActive(state);
    if (!description.trim()) throw new InvariantError("apply/gap-description-blank", "能力缺口说明不能为空");
    state.cognition ??= { revision: 1, recipeVersion: 1, summary: state.objective, candidates: [], nodes: [], gaps: [], amendments: [] };
    if (state.cognition.gaps.some(item => item.kind === kind && item.description === description.trim())) return;
    state.cognition.gaps.push({ kind, description: description.trim(), recordedAt });
    state.cognition.revision++;
  },

  // `resolveCapabilityGap` never asserted an active task; the reducer keeps that.
  "capability-gap/resolved": (state, event) => {
    const { kind, description, resolution, resolvedAt } = event.payload;
    if (!resolution.trim()) throw new InvariantError("apply/gap-resolution-blank", "能力缺口解决依据不能为空");
    const gap = state.cognition?.gaps.find(item => item.kind === kind && item.description === description && !item.resolvedAt);
    if (!gap) throw new InvariantError("apply/gap-not-open", "待解决的能力缺口不存在");
    gap.resolvedAt = resolvedAt;
    gap.resolution = resolution.trim();
    delete gap.blockingReason;
    state.cognition!.revision++;
  },

  "skill-search/recorded": (state, event) => {
    const input = event.payload;
    assertActive(state);
    const cognition = state.cognition!;
    if (cognition.skillSearches?.some(item => item.key === input.key)) return;
    (cognition.skillSearches ??= []).push({ key: input.key, gapDescription: input.gapDescription, query: input.query, resultCount: input.resultCount, ...(input.error ? { error: input.error } : {}), recordedAt: input.recordedAt });
    (cognition.skillProposals ??= []).push(...input.proposals);
    cognition.revision++;
  },

  "expert-proposal/recorded": (state, event) => {
    assertActive(state);
    const cognition = state.cognition!;
    (cognition.expertProposals ??= []).push({ ...event.payload.proposal, status: "pending" });
    cognition.revision++;
  },

  "expert-proposal/decided": (state, event) => {
    const { id, decision, installedExpertId, resolvedAt } = event.payload;
    assertActive(state);
    const proposal = state.cognition?.expertProposals?.find(item => item.id === id);
    if (!proposal || proposal.status !== "pending") throw new InvariantError("apply/expert-proposal-unhandled-missing", "专家提案不存在或已处理");
    if (decision === "installed" && !installedExpertId) throw new InvariantError("apply/installed-expert-id-missing", "入库后的专家 ID 缺失");
    proposal.status = decision;
    if (installedExpertId) proposal.installedExpertId = installedExpertId;
    proposal.resolvedAt = resolvedAt;
    state.cognition!.revision++;
  },

  "skill-proposal/decided": (state, event) => {
    const { id, decision, installedSkillId, resolvedAt } = event.payload;
    assertActive(state);
    const proposal = state.cognition?.skillProposals?.find(item => item.id === id);
    if (!proposal || proposal.status !== "pending") throw new InvariantError("apply/skill-proposal-unhandled-missing", "Skill 提案不存在或已处理");
    if (decision === "installed" && !installedSkillId) throw new InvariantError("apply/installed-skill-id-missing", "安装后的 Skill ID 缺失");
    proposal.status = decision;
    if (installedSkillId) proposal.installedSkillId = installedSkillId;
    state.cognition!.revision++;
    if (decision === "installed") {
      (state.cognition!.taskSkillIds ??= []).push(installedSkillId!);
      const search = state.cognition!.skillSearches?.find(item => item.key === proposal.key);
      const gap = state.cognition!.gaps.find(item => !item.resolvedAt && item.kind === "method" && item.description === search?.gapDescription);
      const blockers = [
        ...(proposal.requirements?.services.map(service => `需要外部服务 ${service}`) ?? []),
        ...(proposal.requirements?.tools.filter(tool => !WORKER_TOOLS[tool]).map(tool => `worker 缺少工具 ${tool}`) ?? []),
        ...(proposal.requirements?.conflicts.filter(other => state.cognition!.taskSkillIds?.includes(other)).map(other => `与 ${other} 冲突`) ?? []),
      ];
      if (gap && !blockers.length) { gap.resolvedAt = resolvedAt; gap.resolution = `Installed ${installedSkillId}`; delete gap.blockingReason; }
      else if (gap) gap.blockingReason = `已安装 ${installedSkillId}，但${blockers.join("、")}；仍需调整执行方式或能力`;
    }
  },
};
