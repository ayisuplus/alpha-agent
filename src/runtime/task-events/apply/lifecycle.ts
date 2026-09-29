import { computeCompletionGaps } from "../../task-completion";
import type { TaskState } from "../../task-ledger";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";

/** Lifecycle family: status transitions, planning phase, source revision, failures and checkpoints. */

function assertActive(state: TaskState): void {
  if (state.status !== "active") throw new InvariantError("apply/task-not-active", `Task is ${state.status}`);
}

export const lifecycleReducers: FamilyReducers = {
  "status/changed": (state, event) => {
    const payload = event.payload;
    switch (payload.status) {
      case "complete": {
        assertActive(state);
        // A light run (C3) has no plan graph, so plan approval is vacuous for it; full runs still need the approval.
        if (!state.light && state.phase !== "execute" && state.phase !== undefined) throw new InvariantError("apply/plan-not-approved", "Task plan is not approved for execution");
        const gaps = computeCompletionGaps(state);
        if (gaps.length > 0) throw new InvariantError("apply/completion-gaps", `Task cannot complete: ${gaps.join(", ")}`);
        state.status = "complete";
        state.lastFailure = undefined;
        state.reopenReason = undefined;
        delete state.stop;
        return;
      }
      case "stopped": {
        assertActive(state);
        state.status = "stopped";
        state.stop = { reason: payload.reason, ...(payload.detail ? { detail: payload.detail } : {}), stoppedAt: event.at };
        return;
      }
      case "active": {
        if (payload.guidance) {
          // resume(): the guidance record marks a resume and is replayed into the history verbatim.
          if (state.status !== "stopped" && state.status !== "needs-input") throw new InvariantError("apply/resume-not-paused", "Only a stopped or waiting task can be resumed");
          if (!payload.reopenReason.trim()) throw new InvariantError("apply/resume-reason-blank", "Resume reason is required");
          state.status = "active";
          delete state.pendingQuestion;
          delete state.pauseReason;
          delete state.stop;
          state.reopenReason = payload.reopenReason.trim();
          if (state.goal) { state.goal.stopReason = undefined; state.goal.noProgressRuns = 0; }
          state.guidanceHistory ??= [];
          state.guidanceHistory.push({ ...payload.guidance });
          return;
        }
        // reopen()
        if (state.status !== "complete") throw new InvariantError("apply/reopen-not-complete", "Only a completed task can be reopened");
        if (!payload.reopenReason.trim()) throw new InvariantError("apply/reopen-reason-blank", "Reopen reason is required");
        state.status = "active";
        state.reopenReason = payload.reopenReason.trim();
        delete state.stop;
        return;
      }
      case "needs-input": {
        assertActive(state);
        if (!payload.question.trim()) throw new InvariantError("apply/question-blank", "A user question is required");
        state.status = "needs-input";
        state.pendingQuestion = payload.question.trim();
        if (payload.reason) state.pauseReason = payload.reason;
        return;
      }
    }
  },

  "phase/changed": (state, event) => {
    const { phase, clearPause } = event.payload;
    if (state.status === "complete") throw new InvariantError("apply/plan-on-complete", "Completed task cannot enter planning");
    if (state.status === "stopped" || state.status === "needs-input") state.status = "active";
    if (clearPause) {
      delete state.pendingQuestion;
      delete state.pauseReason;
      delete state.stop;
    }
    state.phase = phase;
    delete state.planApproval;
    if (state.goal) { state.goal.stopReason = undefined; state.goal.noProgressRuns = 0; }
  },

  "source/revision-refreshed": (state, event) => {
    state.revision = event.payload.revision;
    state.preview = null;
  },

  "failure/recorded": (state, event) => {
    assertActive(state);
    if (!event.payload.reason.trim()) throw new InvariantError("apply/failure-reason-blank", "Failure reason is required");
    state.lastFailure = event.payload.reason.trim();
  },

  "failure/cleared": (state) => {
    if (!state.lastFailure) return;
    state.lastFailure = undefined;
  },

  "checkpoint/started": (state) => {
    state.checkpointStatus = "pending";
    delete state.checkpointError;
  },

  "checkpoint/committed": (state, event) => {
    const checkpoint = event.payload.checkpoint;
    if (state.checkpoint?.runId === checkpoint.runId && state.checkpoint.memoryCommit === checkpoint.memoryCommit && state.checkpointStatus === "committed") return;
    state.checkpoint = checkpoint;
    state.checkpointStatus = "committed";
    delete state.checkpointError;
  },

  "checkpoint/failed": (state, event) => {
    state.checkpointError = event.payload.reason;
    state.checkpointStatus = "failed";
  },
};
