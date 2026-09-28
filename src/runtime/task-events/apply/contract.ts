import { InvariantError } from "../errors";
import { replaceState } from "../state";
import type { FamilyReducers } from "../types";

/** Reference family: contract, inputs, capabilities, guidance and goal events. */

export const contractReducers: FamilyReducers = {
  "task/created": (state, event) => replaceState(state, event.payload.state),
  "task/imported": (state, event) => replaceState(state, event.payload.state),

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
    delete state.blockedService;
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
    state.guidanceHistory.push(event.payload.guidance);
  },

  "guidance/status-changed": (state, event) => {
    const guidance = state.guidanceHistory?.find(item => item.id === event.payload.id);
    if (!guidance) throw new InvariantError("apply/guidance-missing", "Guidance not found");
    if (guidance.status === "processed" || guidance.status === event.payload.status) return;
    guidance.status = event.payload.status;
  },

  // No status guard here: `setGoal` rejects a completed task in the ledger method, `setGoalProgress` never did.
  "goal/changed": (state, event) => { state.goal = event.payload.goal; },
};
