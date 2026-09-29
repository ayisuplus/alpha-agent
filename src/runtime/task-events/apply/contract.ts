import { reasonFromLegacyService } from "../../pause-reasons";
import type { TaskState } from "../../task-ledger";
import { mapNodeKind } from "../../plan-kind";
import { InvariantError } from "../errors";
import { replaceState } from "../state";
import type { FamilyReducers } from "../types";
import { normalizePlanNode } from "./plan";

/** Reference family: contract, inputs, capabilities, guidance and goal events. */

/**
 * Tasks recorded before the plan-graph vocabulary carry `steps` with `mode` and old statuses, and instances or agents
 * with `mode`; the fold reads them as execute-stage nodes and mapped kinds (§8 旧任务按单节点图读取).
 */
function normalizeLegacyGraph(state: TaskState): void {
  const cognition = state.cognition as (TaskState["cognition"] & { steps?: unknown[] }) | undefined;
  if (!cognition) return;
  if (!Array.isArray((cognition as { nodes?: unknown[] }).nodes)) {
    const legacySteps = "steps" in cognition ? cognition.steps : undefined;
    if (Array.isArray(legacySteps)) cognition.nodes = legacySteps.map(normalizePlanNode);
    delete cognition.steps;
  }
  for (const instance of cognition.instances ?? []) {
    const legacy = instance as { mode?: "investigate" | "implement" | "review" };
    if (instance.kind === undefined && legacy.mode !== undefined) instance.kind = mapNodeKind(legacy.mode) ?? "execute";
  }
  for (const agent of cognition.agents ?? []) {
    const legacy = agent as { mode?: "investigate" | "implement" | "review" };
    if (agent.kind === undefined && legacy.mode !== undefined) agent.kind = mapNodeKind(legacy.mode) ?? "execute";
  }
  for (const amendment of cognition.amendments ?? []) {
    const legacy = amendment as { affectedSteps?: string[]; affectedNodes?: string[] };
    if (!legacy.affectedNodes && Array.isArray(legacy.affectedSteps)) (amendment as { affectedNodes?: string[] }).affectedNodes = legacy.affectedSteps;
  }
}

export const contractReducers: FamilyReducers = {
  // The origin payload is the pre-image of the whole state; clone it so folding can never write through the event
  // object (folds replay the same read events and must stay deterministic).
  "task/created": (state, event) => { replaceState(state, structuredClone(event.payload.state)); normalizeLegacyGraph(state); },
  "task/imported": (state, event) => {
    replaceState(state, structuredClone(event.payload.state));
    normalizeLegacyGraph(state);
    // Ledgers from before reason codes carried a free-text service name; the event payload keeps the original value.
    const legacy = state as { blockedService?: string };
    if (legacy.blockedService !== undefined) {
      const reason = reasonFromLegacyService(legacy.blockedService);
      delete legacy.blockedService;
      if (reason) state.pauseReason = reason;
    }
  },

  "contract/revised": (state, event) => {
    const { objective, contractVersion, historyEntry, reopenReason } = event.payload;
    if (!objective.trim() || objective === state.objective) throw new InvariantError("apply/objective-unchanged", "A changed task objective is required");
    if (contractVersion !== (state.contractVersion ?? 1) + 1) throw new InvariantError("apply/contract-version-not-next", `Contract version ${contractVersion} does not follow ${(state.contractVersion ?? 1)}`);
    state.contractHistory ??= [];
    state.contractHistory.push(historyEntry);
    state.objective = objective;
    state.contractVersion = contractVersion;
    if (state.planApproval || state.phase === "plan-review" || state.phase === "plan") { state.phase = "plan"; delete state.planApproval; }
    state.preview = null;
    state.status = "active";
    state.reopenReason = reopenReason;
    state.lastFailure = undefined;
    // Revising the objective resumes the task, so the pause it was waiting on no longer applies.
    delete state.pendingQuestion;
    delete state.pauseReason;
    delete state.stop;
    if (state.goal) { state.goal.stopReason = undefined; state.goal.noProgressRuns = 0; }
  },

  "criteria/set": (state, event) => {
    const criteria = event.payload.criteria;
    if (state.taskType !== "general" || new Set(criteria.map(item => item.id)).size !== criteria.length) throw new InvariantError("apply/criteria-invalid", "Invalid general task criteria");
    state.criteria = criteria;
  },

  "input/attached": (state, event) => {
    if (state.status === "complete") throw new InvariantError("apply/inputs-on-complete", "Revise a completed task before adding inputs");
    state.inputs = [...(state.inputs ?? []), ...event.payload.inputs];
  },

  "capabilities/set": (state, event) => {
    if (state.status === "complete") throw new InvariantError("apply/capabilities-on-complete", "Revise a completed task before selecting capabilities");
    state.capabilities = event.payload.capabilities;
  },

  "project-version/confirmed": (state, event) => {
    const version = event.payload.version;
    if (!state.projectId || !Number.isInteger(version) || version < 1 || !["needs-input", "stopped"].includes(state.status)) {
      throw new InvariantError("apply/project-version-not-waiting", "Task is not waiting for a project recheck");
    }
    state.projectVersion = version;
    state.status = "stopped";
    delete state.pendingQuestion;
    delete state.pauseReason;
    delete state.stop;
    state.reopenReason = "Project folders rechecked; continue the task when ready";
  },

  "model/set": (state, event) => {
    if (event.payload.selector) state.modelSelector = event.payload.selector;
    else delete state.modelSelector;
  },

  "guidance/recorded": (state, event) => {
    if (state.status === "complete") throw new InvariantError("apply/guidance-on-complete", "A completed task cannot receive guidance");
    if (!event.payload.guidance.instruction.trim()) throw new InvariantError("apply/guidance-blank", "Guidance is required");
    state.guidanceHistory ??= [];
    // Copy: later guidance/status-changed writes through the stored record and must not touch the event payload.
    state.guidanceHistory.push({ ...event.payload.guidance });
  },

  "guidance/status-changed": (state, event) => {
    const guidance = state.guidanceHistory?.find(item => item.id === event.payload.id);
    if (!guidance) throw new InvariantError("apply/guidance-missing", "Guidance not found");
    if (guidance.status === "processed" || guidance.status === event.payload.status) return;
    guidance.status = event.payload.status;
  },

  // No status guard here: `setGoal` rejects a completed task in the ledger method, `setGoalProgress` never did.
  "goal/changed": (state, event) => {
    const expected = (state.goal?.revision ?? 0) + 1;
    if (event.payload.goal.revision !== expected) throw new InvariantError("apply/goal-revision-not-next", `Goal revision ${event.payload.goal.revision} does not follow ${state.goal?.revision ?? 0}`);
    // Copy: plan/approved, contract/revised and phase/changed write stopReason/noProgressRuns through the stored goal.
    state.goal = { ...event.payload.goal };
  },
};
