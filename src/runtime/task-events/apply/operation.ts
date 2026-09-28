import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/** Operation family: the per-task operation latch, kept as an event so a restart can see which run was live. */

export const operationReducers: FamilyReducers = {
  "operation/started": (state, event) => {
    if (state.operation?.status === "running" && state.operation.runId !== event.payload.runId) {
      throw new InvariantError("apply/operation-running", "Task has an unreconciled operation");
    }
    state.operation = { runId: event.payload.runId, startedAt: event.payload.startedAt, status: "running" };
  },

  "operation/finished": (state, event) => {
    if (!state.operation || state.operation.runId !== event.payload.runId) return;
    state.operation.status = "finished";
    state.operation.finishedAt = event.payload.finishedAt;
  },
};
