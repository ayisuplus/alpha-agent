import type { CognitionState, TaskState } from "../../task-ledger";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/** Worker family: dispatch/queue attempts, agent mirroring, worker cognition, receipts, requests, runs and outcomes. */

/** Reserved order ids that never map to a plan step; today's ledger skips them when marking steps. */
const RESERVED_ORDER_IDS: Record<string, true> = { coordinator: true, "final-review": true, "review-repair": true };

function assertActive(state: TaskState): void {
  if (state.status !== "active") throw new InvariantError("apply/task-not-active", `Task is ${state.status}`);
}

function ensureCognition(state: TaskState): CognitionState {
  state.cognition ??= { revision: 1, recipeVersion: 1, summary: state.objective, candidates: [], steps: [], gaps: [], amendments: [] };
  return state.cognition;
}

export const workerReducers: FamilyReducers = {
  "worker/dispatched": (state, event) => {
    assertActive(state);
    const cognition = ensureCognition(state);
    const { startedAt, ...input } = event.payload;
    if (cognition.instances?.some(item => item.id === input.id)) return;
    (cognition.instances ??= []).push({ ...input, skills: input.skills.map(item => ({ ...item })), contractVersion: state.contractVersion ?? 1, cognitionRevision: cognition.revision, baseRevision: state.revision, status: "running", startedAt });
    const step = RESERVED_ORDER_IDS[input.orderId] ? undefined : cognition.steps.find(item => item.id === input.orderId);
    if (step) { step.status = "running"; step.statusReason = `工单 ${input.id} 运行中`; }
  },

  "worker/queued": (state, event) => {
    assertActive(state);
    const cognition = ensureCognition(state);
    const { attemptId, parentId, order, preset, expert, startedAt } = event.payload;
    if (cognition.instances?.some(item => item.id === attemptId)) throw new InvariantError("apply/worker-attempt-exists", "Worker attempt already exists");
    if (order.agentId) {
      if (!preset && (!order.acceptance?.some(item => item.trim()) || !(order.ownedPaths.length || order.readPaths?.length))) throw new InvariantError("apply/neutral-subagent-underspecified", "Neutral subagent requires acceptance criteria and source scope");
      const agents = cognition.agents ??= [];
      const existing = agents.find(item => item.id === order.agentId);
      if (existing) {
        if (existing.expert?.hash !== preset?.hash || existing.orderId !== order.id || existing.skillIds.some(id => !(order.skillIds ?? []).includes(id))) throw new InvariantError("apply/subagent-identity-changed", "Subagent identity or expert/skills changed");
        if (["queued", "running"].includes(existing.status)) throw new InvariantError("apply/subagent-already-running", "Subagent is already running");
        const previous = (cognition.instances ?? []).find(item => item.id === existing.lastAttemptId);
        if (previous?.status === "returned") { previous.status = "cancelled"; previous.findings = [...(previous.findings ?? []), "Superseded by continuation"]; previous.endedAt = startedAt; }
        existing.lastAttemptId = attemptId;
        existing.mode = order.mode ?? "implement";
        existing.capabilityIds = [...(order.capabilityIds ?? [])];
        existing.contextRevision = order.contextRevision ?? existing.contextRevision ?? 1;
        existing.status = "queued";
      } else agents.push({ id: order.agentId, ...(preset ? { expert: preset } : {}), skillIds: [...(order.skillIds ?? [])], capabilityIds: [...(order.capabilityIds ?? [])], contextRevision: order.contextRevision ?? 1, mode: order.mode ?? "implement", orderId: order.id, lastAttemptId: attemptId, status: "queued" });
    }
    (cognition.instances ??= []).push({ id: attemptId, agentId: order.agentId, parentId, orderId: order.id, order, decisionReason: order.decisionReason, mode: order.mode ?? "implement", expert, skills: [], contractVersion: state.contractVersion ?? 1, cognitionRevision: cognition.revision, baseRevision: state.revision, status: "queued", startedAt });
    const step = cognition.steps.find(item => item.id === order.id);
    if (step) { step.status = "running"; step.statusReason = `工单 ${attemptId} 排队中`; }
  },

  "worker/updated": (state, event) => {
    const { id, status, patch, endedAt } = event.payload;
    const instance = state.cognition?.instances?.find(item => item.id === id);
    if (!instance || !instance.order) throw new InvariantError("apply/worker-attempt-missing", "Worker attempt not found");
    if (["completed", "blocked", "failed", "cancelled"].includes(instance.status)) return;
    Object.assign(instance, patch, { status });
    const agent = state.cognition?.agents?.find(item => item.id === instance.agentId);
    if (agent && agent.lastAttemptId === id) {
      agent.status = status === "blocked" ? "waiting-primary" : status;
      if (patch.cognition) agent.cognition = patch.cognition;
      if (patch.skills) {
        agent.skillIds = patch.skills.map(item => item.id);
        agent.skillSnapshots = patch.skills.map(item => ({ ...item }));
        if (instance.order) instance.order.skillSnapshots = patch.skills.map(item => ({ ...item }));
      }
      if (patch.capabilities) {
        agent.capabilitySnapshots = patch.capabilities.map(item => ({ ...item }));
        if (instance.order) instance.order.capabilitySnapshots = patch.capabilities.map(item => ({ ...item }));
      }
    }
    if (status !== "running") instance.endedAt = endedAt;
    const step = state.cognition?.steps.find(item => item.id === instance.orderId);
    if (step) { step.status = status === "completed" ? "complete" : ["blocked", "failed", "cancelled"].includes(status) ? "blocked" : "running"; step.statusReason = `工单 ${id} ${status}${patch.integration ? ` / ${patch.integration}` : ""}`; }
  },

  // The ledger method computes `sourceRevision` via fingerprintSource and folds revision/updatedAt in before
  // writing the event, so the payload already carries the final WorkerCognition.
  "worker-cognition/updated": (state, event) => {
    assertActive(state);
    const cognition = event.payload.cognition;
    if (!cognition.understanding.trim() || cognition.understanding.length > 2_000 || cognition.findings.length > 20 || cognition.openQuestions.length > 20 || cognition.nextActions.length > 20) throw new InvariantError("apply/worker-cognition-invalid", "Worker cognition is invalid or too large");
    const known = new Set((state.workerReceipts ?? []).map(item => item.id));
    if (cognition.findings.some(item => !item.text.trim() || item.text.length > 500 || item.evidence.some(id => !known.has(id)))) throw new InvariantError("apply/worker-citation-unknown", "Worker finding cites an unknown evidence receipt");
    state.workerCognition = cognition;
  },

  "worker-receipt/recorded": (state, event) => {
    (state.workerReceipts ??= []).push(event.payload.receipt);
  },

  "worker-request/recorded": (state, event) => {
    const request = event.payload.request;
    const existing = state.workerRequests?.find(item => item.id === request.id);
    if (existing) {
      for (const key of ["agentId", "runId", "orderId", "kind", "blockedStep", "contractVersion", "sourceRevision"] as const) if (existing[key] !== request[key]) throw new InvariantError("apply/worker-request-id-reused", "Worker request ID was reused");
      return;
    }
    if (!state.cognition?.instances?.some(item => item.id === request.runId && item.agentId === request.agentId)) throw new InvariantError("apply/worker-request-no-run", "Worker request has no matching run");
    (state.workerRequests ??= []).push(request);
  },

  "worker-request/updated": (state, event) => {
    const { id, patch, resolvedAt, clearResolvedAt } = event.payload;
    const request = state.workerRequests?.find(item => item.id === id);
    if (!request) throw new InvariantError("apply/worker-request-missing", "Worker request not found");
    if (["applied", "rejected"].includes(request.status)) throw new InvariantError("apply/worker-request-resolved", "Worker request is already resolved");
    Object.assign(request, patch);
    if (["applied", "rejected", "uncertain"].includes(patch.status)) request.resolvedAt = resolvedAt;
    else if (clearResolvedAt) delete request.resolvedAt;
  },

  "worker-run/prepared": (state) => {
    if (state.status === "complete") throw new InvariantError("apply/worker-run-on-complete", "Completed worker state cannot be continued");
    state.status = "active";
    delete state.pendingQuestion;
    delete state.pauseReason;
    delete state.stop;
    delete state.workerOutcome;
  },

  "worker/finished": (state, event) => {
    const { id, status, findings, endedAt } = event.payload;
    const instance = state.cognition?.instances?.find(item => item.id === id);
    if (!instance || instance.status !== "running") return;
    instance.status = status;
    instance.findings = findings;
    instance.endedAt = endedAt;
    const step = RESERVED_ORDER_IDS[instance.orderId] ? undefined : state.cognition?.steps.find(item => item.id === instance.orderId);
    if (step) { step.status = status === "completed" ? "complete" : status === "cancelled" ? "cancelled" : "blocked"; step.statusReason = findings.join("；") || `工单 ${id} ${status}`; }
  },

  "workers/reconciled": (state, event) => {
    const running = state.cognition?.instances?.filter(item => item.status === "running" || item.status === "queued") ?? [];
    if (!running.length) return;
    for (const instance of running) {
      instance.status = "failed";
      instance.findings = [event.payload.reason];
      instance.endedAt = event.payload.endedAt;
      const step = state.cognition?.steps.find(item => item.id === instance.orderId);
      if (step) step.status = "blocked";
    }
  },

  "worker-outcome/recorded": (state, event) => {
    assertActive(state);
    const outcome = event.payload.outcome;
    state.workerOutcome = { ...outcome, requests: outcome.requests ?? state.workerOutcome?.requests, findings: outcome.findings.map(item => item.trim()).filter(Boolean) };
  },
};
