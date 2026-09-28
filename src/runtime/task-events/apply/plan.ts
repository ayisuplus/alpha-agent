import type { CognitionStep, TaskState } from "../../task-ledger";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/** Plan family: plan submission/approval/revision, step status, candidates, capability gaps, skill search and proposals. */

/** Tools every worker already has; a proposal requiring anything else is blocked (see `decideSkillProposal`). */
const WORKER_TOOLS: Record<string, true> = { read: true, grep: true, edit: true, write: true, alpha_build: true, alpha_worker_result: true };

/** `assertActive` lives in every reducer whose ledger method had it, so a fold rejects the same events. */
function assertActive(state: TaskState): void {
  if (state.status !== "active") throw new InvariantError("apply/task-not-active", `Task is ${state.status}`);
}

export const planReducers: FamilyReducers = {
  "plan/submitted": (state) => {
    if (state.phase !== "plan" || !state.cognition?.steps.length) throw new InvariantError("apply/plan-empty", "A nonempty plan is required for review");
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
    const input = event.payload.input;
    if (!input.summary.trim() || !input.reason.trim() || input.steps.length > 20) throw new InvariantError("apply/cognition-content-invalid", "认知修订内容无效");
    const ids = new Set(input.steps.map(step => step.id));
    if (ids.size !== input.steps.length || input.steps.some(step => !/^[a-z][a-z0-9-]{0,31}$/.test(step.id) || ["coordinator", "final-review", "review-repair"].includes(step.id) || !step.objective.trim() || step.dependsOn.some(id => !ids.has(id) || id === step.id))) throw new InvariantError("apply/cognition-steps-invalid", "认知步骤无效");
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(input.steps.map(step => [step.id, step]));
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new InvariantError("apply/cognition-cycle", "认知步骤存在循环依赖");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
    const previous = state.cognition ?? { revision: 0, recipeVersion: 1, summary: state.objective, candidates: [], steps: [], gaps: [], amendments: [] };
    if (state.designatedExpertId && (!input.candidates.includes(state.designatedExpertId) || (input.steps.length > 0 && !input.steps.some(step => step.expertId === state.designatedExpertId)))) throw new InvariantError("apply/designated-expert-dropped", `用户指定专家必须保留在计划中：${state.designatedExpertId}`);
    for (const prior of previous.steps.filter(step => step.status === "running" || step.status === "complete" || step.claimedBy !== undefined)) {
      const next = input.steps.find(step => step.id === prior.id);
      if (!next || next.objective !== prior.objective || next.mode !== prior.mode || next.expertId !== prior.expertId || JSON.stringify(next.dependsOn) !== JSON.stringify(prior.dependsOn) || JSON.stringify(next.skillIds) !== JSON.stringify(prior.skillIds)) throw new InvariantError("apply/dispatched-step-rewritten", `已派发或完成的认知步骤不可改写：${prior.id}`);
    }
    const revision = previous.revision + 1;
    const clean = (values: string[] | undefined, fallback: string[] | undefined) => values === undefined ? fallback : [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 20);
    const nextScope = clean(input.scope, previous.scope);
    const nextConstraints = clean(input.constraints, previous.constraints);
    const stepDefinition = (step: CognitionStep) => JSON.stringify([step.objective, step.mode, step.expertId ?? null, step.dependsOn, step.skillIds]);
    const materialChange = !!state.planApproval && (JSON.stringify(nextScope) !== JSON.stringify(previous.scope) || JSON.stringify(nextConstraints) !== JSON.stringify(previous.constraints) || input.steps.some(step => !previous.steps.some(prior => prior.id === step.id)) || previous.steps.some(prior => prior.status !== "complete" && prior.status !== "running" && !input.steps.some(step => step.id === prior.id && stepDefinition(step) === stepDefinition(prior))));
    state.cognition = { ...previous, revision, basedOnRevision: state.revision, summary: input.summary.trim(), scope: nextScope, constraints: nextConstraints, openQuestions: clean(input.openQuestions, previous.openQuestions), candidates: [...new Set(input.candidates)], steps: input.steps.map(step => {
      const prior = previous.steps.find(item => item.id === step.id);
      return { ...step, status: prior?.status ?? "planned", statusReason: prior?.statusReason, revision: prior?.revision, claimedBy: prior?.claimedBy, dependsOn: [...step.dependsOn], skillIds: [...step.skillIds] };
    }), amendments: [...previous.amendments, { revision, reason: input.reason.trim(), affectedSteps: input.steps.map(step => step.id), recordedAt: event.payload.recordedAt }] };
    if (materialChange) { state.phase = "plan-review"; delete state.planApproval; }
  },

  "step/changed": (state, event) => {
    const { id, status, reason, expectedRevision, claimedBy } = event.payload;
    assertActive(state);
    const step = state.cognition?.steps.find(item => item.id === id);
    if (!step || !["running", "complete", "blocked", "cancelled"].includes(status) || !reason.trim()) throw new InvariantError("apply/step-required", "Step and reason are required");
    if (expectedRevision !== undefined && expectedRevision !== (step.revision ?? 0)) throw new InvariantError("apply/step-revision-conflict", `Step ${id} moved on: expected revision ${expectedRevision}, found ${step.revision ?? 0}`);
    if (step.status === "complete" || step.status === "cancelled") throw new InvariantError("apply/step-finished", "Finished step cannot be rewritten");
    if (state.cognition?.instances?.some(instance => instance.orderId === id)) throw new InvariantError("apply/step-delegated", "Delegated step status is owned by the work order result");
    if (state.phase === "plan" && step.mode !== "investigate") throw new InvariantError("apply/step-plan-mode", "Planning can only finish investigation steps");
    if (state.phase === "plan-review") throw new InvariantError("apply/plan-awaiting-review", "Plan is awaiting review");
    if (status === "complete" && step.dependsOn.some(dep => state.cognition?.steps.find(item => item.id === dep)?.status !== "complete")) throw new InvariantError("apply/step-deps-incomplete", "Step dependencies are not complete");
    step.status = status;
    step.statusReason = reason.trim();
    step.revision = (step.revision ?? 0) + 1;
    if (claimedBy !== undefined) step.claimedBy = claimedBy;
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
    state.cognition ??= { revision: 1, recipeVersion: 1, summary: state.objective, candidates: [], steps: [], gaps: [], amendments: [] };
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
