import { expect, test } from "bun:test";
import { InvariantError, applyEvent, type TaskEventPlan } from "../src/runtime/task-events";
import type { TaskState } from "../src/runtime/task-ledger";

const revision = "a".repeat(64);
const at = "2026-09-28T10:00:00.000Z";

function baseState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1", taskType: "code-change", objective: "Fix the cart total", contractVersion: 1, contractHistory: [],
    guidanceHistory: [], cognition: { revision: 1, recipeVersion: 1, summary: "Fix the cart total", candidates: [], steps: [], gaps: [], amendments: [] },
    projectRoot: "/tmp/project", criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }],
    status: "active", phase: "execute", revision, evidence: [], runs: [], preview: null,
    createdAt: "2026-09-28T09:00:00.000Z", updatedAt: "2026-09-28T09:30:00.000Z", ...overrides,
  };
}

/** Runs one event through the shared dispatch and returns the resulting state. */
function apply(state: TaskState, plan: TaskEventPlan, timestamp = at): TaskState {
  applyEvent(state, { seq: 1, at: timestamp, actor: "runtime", ...plan } as never);
  return state;
}

function codeOf(state: TaskState, plan: TaskEventPlan): string | null {
  try { apply(state, plan); return null; } catch (error) { return (error as InvariantError).code; }
}

test("origin events replace the state and only the import keeps its timestamp", () => {
  const created = baseState({ id: "task-2", objective: "Created" });
  const folded = apply({} as TaskState, { type: "task/created", payload: { state: created } });
  expect(folded).toEqual({ ...created, updatedAt: at });
  expect(folded.updatedAt).toBe(at);
  expect(Object.keys(folded)).toEqual(Object.keys(created));

  const legacy = baseState({ id: "task-3", status: "stopped", lastFailure: "User cancelled" });
  const imported = apply({ stale: true } as never as TaskState, { type: "task/imported", payload: { state: legacy, source: "legacy-json" } });
  expect(imported).toEqual(legacy);
  expect(imported.updatedAt).toBe("2026-09-28T09:30:00.000Z");
  expect("stale" in imported).toBe(false);
});

test("revising the objective retires the old evidence and reopens planning", () => {
  const state = baseState({
    contractVersion: 2, contractHistory: [{ version: 1, objective: "First", revisedAt: at }],
    planApproval: { contractVersion: 2, cognitionRevision: 1, sourceRevision: revision, approvedAt: at },
    phase: "execute", preview: { id: "preview", revision, path: "/tmp/preview", url: "http://127.0.0.1:8123/", recordedAt: at },
    lastFailure: "Browser check failed", goal: { enabled: true, noProgressRuns: 2, stopReason: "no-progress" },
  });
  const revised = apply(state, {
    type: "contract/revised",
    payload: { objective: "Also handle empty carts", contractVersion: 3, historyEntry: { version: 2, objective: "Fix the cart total", revisedAt: at }, reopenReason: "User revised the task objective" },
  });
  expect(revised.contractVersion).toBe(3);
  expect(revised.contractHistory?.map(entry => entry.version)).toEqual([1, 2]);
  expect(revised.objective).toBe("Also handle empty carts");
  expect(revised.phase).toBe("plan");
  expect(revised.planApproval).toBeUndefined();
  expect(revised.preview).toBeNull();
  expect(revised.status).toBe("active");
  expect(revised.lastFailure).toBeUndefined();
  expect(revised.goal).toEqual({ enabled: true, noProgressRuns: 0, stopReason: undefined });

  expect(codeOf(baseState(), { type: "contract/revised", payload: { objective: "Fix the cart total", contractVersion: 2, historyEntry: { version: 1, objective: "Fix the cart total", revisedAt: at }, reopenReason: "r" } })).toBe("apply/objective-unchanged");
  expect(codeOf(baseState(), { type: "contract/revised", payload: { objective: "New goal", contractVersion: 5, historyEntry: { version: 1, objective: "Fix the cart total", revisedAt: at }, reopenReason: "r" } })).toBe("apply/contract-version-not-next");
});

test("criteria only change on a general task and inputs stop at acceptance", () => {
  const general = baseState({ taskType: "general", criteria: [] });
  const criteria = [{ id: "answer", description: "Answers the question", kind: "artifact" as const }];
  expect(apply(general, { type: "criteria/set", payload: { criteria } }).criteria).toEqual(criteria);
  expect(codeOf(baseState(), { type: "criteria/set", payload: { criteria } })).toBe("apply/criteria-invalid");
  expect(codeOf(general, { type: "criteria/set", payload: { criteria: [criteria[0], criteria[0]] } })).toBe("apply/criteria-invalid");

  const inputs = [{ id: "input-1", name: "notes.txt", path: "/tmp/notes.txt", mimeType: "text/plain", sha256: "c".repeat(64), uploadedAt: at }];
  expect(apply(baseState(), { type: "input/attached", payload: { inputs } }).inputs).toEqual(inputs);
  expect(apply(baseState({ inputs }), { type: "input/attached", payload: { inputs } }).inputs).toHaveLength(2);
  expect(codeOf(baseState({ status: "complete" }), { type: "input/attached", payload: { inputs } })).toBe("apply/inputs-on-complete");

  const capabilities = { plugins: [{ id: "comfyui", revision: "d".repeat(64) }], skills: [] };
  expect(apply(baseState(), { type: "capabilities/set", payload: { capabilities } }).capabilities).toEqual(capabilities);
  expect(codeOf(baseState({ status: "complete" }), { type: "capabilities/set", payload: { capabilities } })).toBe("apply/capabilities-on-complete");
});

test("confirming a project version stops a waiting task and clears its pause", () => {
  const waiting = baseState({ projectId: "project-1", projectVersion: 1, status: "needs-input", pendingQuestion: "Project folders changed", pauseReason: "project-state" });
  const confirmed = apply(waiting, { type: "project-version/confirmed", payload: { version: 2 } });
  expect(confirmed.projectVersion).toBe(2);
  expect(confirmed.status).toBe("stopped");
  expect(confirmed.pendingQuestion).toBeUndefined();
  expect(confirmed.pauseReason).toBeUndefined();
  expect("pauseReason" in confirmed).toBe(false);
  expect(confirmed.reopenReason).toBe("Project folders rechecked; continue the task when ready");
  expect(confirmed.updatedAt).toBe(at);

  expect(codeOf(baseState({ status: "needs-input" }), { type: "project-version/confirmed", payload: { version: 2 } })).toBe("apply/project-version-not-waiting");
  expect(codeOf(baseState({ projectId: "project-1", status: "stopped" }), { type: "project-version/confirmed", payload: { version: 0 } })).toBe("apply/project-version-not-waiting");
  expect(codeOf(baseState({ projectId: "project-1", status: "needs-input" }), { type: "project-version/confirmed", payload: { version: 1.5 } })).toBe("apply/project-version-not-waiting");
});

test("the model selector is set and cleared", () => {
  expect(apply(baseState(), { type: "model/set", payload: { selector: "test/model" } }).modelSelector).toBe("test/model");
  const cleared = apply(baseState({ modelSelector: "test/model" }), { type: "model/set", payload: { selector: null } });
  expect(cleared.modelSelector).toBeUndefined();
  expect("modelSelector" in cleared).toBe(false);
});

test("guidance is recorded, delivered and processed once", () => {
  const guidance = { id: "guidance-1", instruction: "Keep the API stable", recordedAt: at, status: "recorded" as const };
  const state = apply(baseState(), { type: "guidance/recorded", payload: { guidance } });
  expect(state.guidanceHistory).toEqual([guidance]);
  expect(apply(state, { type: "guidance/status-changed", payload: { id: "guidance-1", status: "delivered" } }).guidanceHistory?.[0].status).toBe("delivered");
  const processed = apply(state, { type: "guidance/status-changed", payload: { id: "guidance-1", status: "processed" } });
  expect(processed.guidanceHistory?.[0].status).toBe("processed");
  // A processed guidance stays processed and a repeated status is a no-op, exactly as the ledger method returned early.
  expect(apply(processed, { type: "guidance/status-changed", payload: { id: "guidance-1", status: "delivered" } }).guidanceHistory?.[0].status).toBe("processed");

  expect(codeOf(baseState({ status: "complete" }), { type: "guidance/recorded", payload: { guidance } })).toBe("apply/guidance-on-complete");
  expect(codeOf(baseState(), { type: "guidance/recorded", payload: { guidance: { ...guidance, instruction: "   " } } })).toBe("apply/guidance-blank");
  expect(codeOf(baseState(), { type: "guidance/status-changed", payload: { id: "missing", status: "delivered" } })).toBe("apply/guidance-missing");
});

test("the goal snapshot replaces the previous continuation state", () => {
  const state = apply(baseState({ goal: { enabled: false, stopReason: "user-disabled" } }), {
    type: "goal/changed",
    payload: { goal: { enabled: true, budget: { maxToolCalls: 40, wallTimeMs: 600_000, maxTotalToolCalls: 120, totalWallTimeMs: 1_800_000 }, noProgressRuns: 0, stopReason: undefined, revision: 1 } },
  });
  expect(state.goal?.enabled).toBe(true);
  expect(state.goal?.budget?.maxToolCalls).toBe(40);
  expect(state.goal?.stopReason).toBeUndefined();
  expect(state.goal?.revision).toBe(1);
  // setGoalProgress never checked the status, so a completed task may still record why it stopped.
  expect(apply(baseState({ status: "complete" }), { type: "goal/changed", payload: { goal: { enabled: false, noProgressRuns: 3, stopReason: "no-progress", revision: 1 } } }).goal?.stopReason).toBe("no-progress");

  // The reducer only accepts the revision that follows the stored one, so a replayed snapshot cannot overwrite it.
  const replayed = baseState({ goal: { enabled: true, noProgressRuns: 1, revision: 2 } });
  expect(codeOf(replayed, { type: "goal/changed", payload: { goal: { enabled: true, noProgressRuns: 9, stopReason: undefined, revision: 2 } } })).toBe("apply/goal-revision-not-next");
  expect(replayed.goal).toEqual({ enabled: true, noProgressRuns: 1, revision: 2 });
});
