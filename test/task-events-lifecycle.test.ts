import { describe, expect, test } from "bun:test";
import { lifecycleReducers } from "../src/runtime/task-events/apply/lifecycle";
import { InvariantError } from "../src/runtime/task-events/errors";
import type { TaskEventOf, TaskEventPayloads, TaskEventType } from "../src/runtime/task-events/types";
import type { GuidanceRecord, TaskState } from "../src/runtime/task-ledger";

function makeState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    objective: "Ship the feature",
    projectRoot: "/repo",
    taskType: "general",
    criteria: [],
    status: "active",
    revision: "rev-1",
    evidence: [],
    preview: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function apply<Type extends TaskEventType>(state: TaskState, type: Type, payload: TaskEventPayloads[Type]): void {
  const reducer = lifecycleReducers[type];
  if (!reducer) throw new Error(`missing reducer for ${type}`);
  const event = { seq: 1, at: "2026-09-28T01:00:00.000Z", actor: "runtime", type, payload } as TaskEventOf<Type>;
  (reducer as (target: TaskState, applied: TaskEventOf<Type>) => void)(state, event);
}

function expectInvariant(run: () => void, code: string, message: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvariantError);
    expect((error as InvariantError).code).toBe(code);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected InvariantError ${code}: ${message}`);
}

const guidance: GuidanceRecord = { instruction: "carry on", recordedAt: "2026-09-28T01:00:00.000Z" };

describe("status/changed", () => {
  test("complete clears the failure, the reopen reason and the stop record", () => {
    const state = makeState({ phase: "execute", lastFailure: "boom", reopenReason: "again", stop: { reason: "error", detail: "boom", stoppedAt: "2026-09-28T00:30:00.000Z" } });
    apply(state, "status/changed", { status: "complete" });
    expect(state.status).toBe("complete");
    expect(state.lastFailure).toBeUndefined();
    expect(state.reopenReason).toBeUndefined();
    expect("stop" in state).toBe(false);
  });

  test("complete accepts a task without a phase", () => {
    const state = makeState();
    apply(state, "status/changed", { status: "complete" });
    expect(state.status).toBe("complete");
  });

  test("complete requires an active task before checking the phase", () => {
    const state = makeState({ status: "stopped", phase: "plan" });
    expectInvariant(() => apply(state, "status/changed", { status: "complete" }), "apply/task-not-active", "Task is stopped");
    expect(state.status).toBe("stopped");
  });

  test("complete rejects an unapproved plan", () => {
    const state = makeState({ phase: "plan-review" });
    expectInvariant(() => apply(state, "status/changed", { status: "complete" }), "apply/plan-not-approved", "Task plan is not approved for execution");
    expect(state.status).toBe("active");
  });

  test("complete rejects open acceptance gaps and lists them", () => {
    const state = makeState({
      criteria: [{ id: "c1", description: "first", kind: "build" }, { id: "c2", description: "second", kind: "test" }],
      evidence: [{ id: "e1", criterionId: "c1", kind: "build", revision: "rev-1", passed: true, source: "build", recordedAt: "2026-09-28T00:30:00.000Z" }],
    });
    expectInvariant(() => apply(state, "status/changed", { status: "complete" }), "apply/completion-gaps", "Task cannot complete: c2");
    expect(state.status).toBe("active");
  });

  test("complete rejects evidence recorded against a stale revision", () => {
    const state = makeState({
      criteria: [{ id: "c1", description: "first", kind: "build" }],
      evidence: [{ id: "e1", criterionId: "c1", kind: "build", revision: "rev-0", passed: true, source: "build", recordedAt: "2026-09-28T00:30:00.000Z" }],
    });
    expectInvariant(() => apply(state, "status/changed", { status: "complete" }), "apply/completion-gaps", "Task cannot complete: c1");
  });

  test("stop requires an active task and records the reason it stopped", () => {
    const state = makeState();
    apply(state, "status/changed", { status: "stopped", reason: "no-progress", detail: "three runs added no evidence" });
    expect(state.status).toBe("stopped");
    expect(state.stop).toEqual({ reason: "no-progress", detail: "three runs added no evidence", stoppedAt: "2026-09-28T01:00:00.000Z" });
    expectInvariant(() => apply(state, "status/changed", { status: "stopped", reason: "user" }), "apply/task-not-active", "Task is stopped");
  });

  test("stop without a detail records only the reason and the event timestamp", () => {
    const state = makeState();
    apply(state, "status/changed", { status: "stopped", reason: "sandbox" });
    expect(state.stop).toEqual({ reason: "sandbox", stoppedAt: "2026-09-28T01:00:00.000Z" });
    expect("detail" in (state.stop ?? {})).toBe(false);
  });

  test("reopen activates a completed task with a trimmed reason", () => {
    const state = makeState({ status: "complete", stop: { reason: "budget", detail: "out of budget", stoppedAt: "2026-09-28T00:30:00.000Z" } });
    apply(state, "status/changed", { status: "active", reopenReason: "  user asked  " });
    expect(state.status).toBe("active");
    expect(state.reopenReason).toBe("user asked");
    expect("stop" in state).toBe(false);
  });

  test("reopen rejects a task that is not complete", () => {
    const state = makeState({ status: "stopped" });
    expectInvariant(() => apply(state, "status/changed", { status: "active", reopenReason: "again" }), "apply/reopen-not-complete", "Only a completed task can be reopened");
    expect(state.status).toBe("stopped");
  });

  test("reopen rejects a blank reason", () => {
    const state = makeState({ status: "complete" });
    expectInvariant(() => apply(state, "status/changed", { status: "active", reopenReason: "   " }), "apply/reopen-reason-blank", "Reopen reason is required");
    expect(state.status).toBe("complete");
  });

  test("resume clears the pause, resets the goal and appends the guidance", () => {
    const state = makeState({
      status: "needs-input",
      pendingQuestion: "which env?",
      pauseReason: "approval",
      goal: { enabled: true, noProgressRuns: 3, stopReason: "no-progress" },
    });
    apply(state, "status/changed", { status: "active", reopenReason: " user answered ", guidance });
    expect(state.status).toBe("active");
    expect("pendingQuestion" in state).toBe(false);
    expect("pauseReason" in state).toBe(false);
    expect(state.reopenReason).toBe("user answered");
    expect(state.goal).toEqual({ enabled: true, noProgressRuns: 0, stopReason: undefined });
    expect(state.guidanceHistory).toEqual([guidance]);
  });

  test("resume from stopped without a goal leaves guidanceHistory initialized", () => {
    const state = makeState({ status: "stopped", stop: { reason: "model", stoppedAt: "2026-09-28T00:30:00.000Z" } });
    apply(state, "status/changed", { status: "active", reopenReason: "go", guidance });
    expect(state.status).toBe("active");
    expect(state.guidanceHistory).toEqual([guidance]);
    expect("stop" in state).toBe(false);
  });

  test("resume rejects a task that is not paused", () => {
    const state = makeState({ status: "complete" });
    expectInvariant(() => apply(state, "status/changed", { status: "active", reopenReason: "go", guidance }), "apply/resume-not-paused", "Only a stopped or waiting task can be resumed");
    expect(state.status).toBe("complete");
  });

  test("resume rejects a blank reason", () => {
    const state = makeState({ status: "stopped" });
    expectInvariant(() => apply(state, "status/changed", { status: "active", reopenReason: " ", guidance }), "apply/resume-reason-blank", "Resume reason is required");
    expect(state.status).toBe("stopped");
    expect(state.guidanceHistory).toBeUndefined();
  });

  test("needInput records the trimmed question and the pause reason only when given", () => {
    const state = makeState();
    apply(state, "status/changed", { status: "needs-input", question: "  pick one  " });
    expect(state.status).toBe("needs-input");
    expect(state.pendingQuestion).toBe("pick one");
    expect("pauseReason" in state).toBe(false);

    const withReason = makeState();
    apply(withReason, "status/changed", { status: "needs-input", question: "approve?", reason: "approval" });
    expect(withReason.pendingQuestion).toBe("approve?");
    expect(withReason.pauseReason).toBe("approval");
  });

  test("needInput rejects a blank question and an inactive task", () => {
    const state = makeState();
    expectInvariant(() => apply(state, "status/changed", { status: "needs-input", question: "  " }), "apply/question-blank", "A user question is required");
    expect(state.status).toBe("active");
    expectInvariant(() => apply(makeState({ status: "complete" }), "status/changed", { status: "needs-input", question: "hi" }), "apply/task-not-active", "Task is complete");
  });
});

describe("phase/changed", () => {
  test("entering planning rejects a completed task", () => {
    const state = makeState({ status: "complete" });
    expectInvariant(() => apply(state, "phase/changed", { phase: "plan", clearPause: false }), "apply/plan-on-complete", "Completed task cannot enter planning");
    expect(state.phase).toBeUndefined();
  });

  test("reactivates a paused task, clears the pause, drops the approval and resets the goal", () => {
    const state = makeState({
      status: "stopped",
      pendingQuestion: "which env?",
      pauseReason: "approval",
      stop: { reason: "no-progress", stoppedAt: "2026-09-28T00:30:00.000Z" },
      phase: "execute",
      planApproval: { contractVersion: 1, cognitionRevision: 2, sourceRevision: "rev-1", approvedAt: "2026-09-28T00:00:00.000Z" },
      goal: { enabled: true, noProgressRuns: 4, stopReason: "no-progress" },
    });
    apply(state, "phase/changed", { phase: "plan", clearPause: true });
    expect(state.status).toBe("active");
    expect("pendingQuestion" in state).toBe(false);
    expect("pauseReason" in state).toBe(false);
    expect("stop" in state).toBe(false);
    expect(state.phase).toBe("plan");
    expect("planApproval" in state).toBe(false);
    expect(state.goal).toEqual({ enabled: true, noProgressRuns: 0, stopReason: undefined });
  });

  test("keeps the pause fields when clearPause is false", () => {
    const state = makeState({ status: "needs-input", pendingQuestion: "which env?", pauseReason: "approval" });
    apply(state, "phase/changed", { phase: "plan-review", clearPause: false });
    expect(state.status).toBe("active");
    expect(state.pendingQuestion).toBe("which env?");
    expect(state.pauseReason).toBe("approval");
    expect(state.phase).toBe("plan-review");
  });

  test("an already active task without a goal keeps its status", () => {
    const state = makeState({ phase: "plan" });
    apply(state, "phase/changed", { phase: "execute", clearPause: true });
    expect(state.status).toBe("active");
    expect(state.phase).toBe("execute");
  });
});

describe("source/revision-refreshed", () => {
  test("records the new revision and invalidates the preview", () => {
    const state = makeState({ preview: { id: "p1", revision: "rev-1", path: "/repo/dist", url: "http://127.0.0.1:4173/", recordedAt: "2026-09-28T00:00:00.000Z" } });
    apply(state, "source/revision-refreshed", { revision: "rev-2" });
    expect(state.revision).toBe("rev-2");
    expect(state.preview).toBeNull();
  });
});

describe("failure events", () => {
  test("records a trimmed failure on an active task", () => {
    const state = makeState();
    apply(state, "failure/recorded", { reason: "  build broke  " });
    expect(state.lastFailure).toBe("build broke");
  });

  test("rejects a blank reason and an inactive task", () => {
    expectInvariant(() => apply(makeState(), "failure/recorded", { reason: "  " }), "apply/failure-reason-blank", "Failure reason is required");
    expectInvariant(() => apply(makeState({ status: "stopped" }), "failure/recorded", { reason: "x" }), "apply/task-not-active", "Task is stopped");
  });

  test("clears an existing failure and is a silent no-op without one", () => {
    const state = makeState({ lastFailure: "boom" });
    apply(state, "failure/cleared", {});
    expect(state.lastFailure).toBeUndefined();

    const clean = makeState();
    apply(clean, "failure/cleared", {});
    expect(clean.lastFailure).toBeUndefined();
  });
});

describe("checkpoint events", () => {
  const checkpoint = { runId: "run-1", codeCommits: [{ root: "/repo", commit: "abc123" }], memoryCommit: "mem-1", recordedAt: "2026-09-28T01:00:00.000Z" };

  test("start marks pending and drops the previous error", () => {
    const state = makeState({ checkpointStatus: "failed", checkpointError: "git blew up" });
    apply(state, "checkpoint/started", {});
    expect(state.checkpointStatus).toBe("pending");
    expect("checkpointError" in state).toBe(false);
  });

  test("commit stores the checkpoint and clears the error", () => {
    const state = makeState({ checkpointStatus: "failed", checkpointError: "git blew up" });
    apply(state, "checkpoint/committed", { checkpoint });
    expect(state.checkpoint).toEqual(checkpoint);
    expect(state.checkpointStatus).toBe("committed");
    expect("checkpointError" in state).toBe(false);
  });

  test("committing the same checkpoint twice is an idempotent no-op", () => {
    const state = makeState();
    apply(state, "checkpoint/committed", { checkpoint });
    const first = state.checkpoint;
    apply(state, "checkpoint/committed", { checkpoint });
    expect(state.checkpoint).toBe(first);
    expect(state.checkpointStatus).toBe("committed");
  });

  test("a different run replaces a committed checkpoint", () => {
    const state = makeState({ checkpoint, checkpointStatus: "committed" });
    const next = { ...checkpoint, runId: "run-2" };
    apply(state, "checkpoint/committed", { checkpoint: next });
    expect(state.checkpoint).toEqual(next);
  });

  test("failure records the reason", () => {
    const state = makeState({ checkpointStatus: "pending" });
    apply(state, "checkpoint/failed", { reason: "git blew up" });
    expect(state.checkpointError).toBe("git blew up");
    expect(state.checkpointStatus).toBe("failed");
  });
});
