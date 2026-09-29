import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_SERVICE_TO_REASON, PAUSE_ACTIONS, PAUSE_REASONS, STOP_REASONS, isPauseReasonCode, pauseActions, reasonFromLegacyService } from "../src/runtime/pause-reasons";
import { TaskLedger, type TaskState } from "../src/runtime/task-ledger";
import { checkTaskInvariants } from "../src/runtime/task-invariants";
import { foldTask, readEvents, taskLogDir } from "../src/runtime/task-events";
import { recordApprovedPlan } from "./support/approved-plan";

const revision = "a".repeat(64);

async function newTask(root: string, name = "project"): Promise<TaskLedger> {
  const projectRoot = join(root, name);
  await Bun.write(join(projectRoot, "app.txt"), "v1");
  return TaskLedger.create(join(root, "data"), {
    objective: "Fix the cart total", projectRoot, taskType: "code-change",
    criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }],
  });
}

/** A ledger written before reason codes existed: its pause lived in a free-text `blockedService`. */
type LegacyTaskState = TaskState & { blockedService?: string };

function legacyState(id: string, projectRoot: string, overrides: Partial<LegacyTaskState> = {}): LegacyTaskState {
  return {
    id, taskType: "code-change", objective: "Legacy task", contractVersion: 1, contractHistory: [], guidanceHistory: [],
    cognition: { revision: 1, recipeVersion: 1, summary: "Legacy task", candidates: [], nodes: [], gaps: [], amendments: [] },
    projectRoot, criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }], status: "needs-input",
    phase: "execute", revision, evidence: [], runs: [], preview: null, pendingQuestion: "Approve the command?",
    createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T09:00:00.000Z", ...overrides,
  };
}

test("every reason code offers at least one resume action and the legacy services all map", () => {
  for (const code of PAUSE_REASONS) expect(PAUSE_ACTIONS[code].length).toBeGreaterThan(0);
  for (const code of PAUSE_REASONS) expect(isPauseReasonCode(code)).toBe(true);
  expect(isPauseReasonCode("windows-sandbox")).toBe(false);
  // The sixteen services written before P2 must all land on a code, otherwise an imported ledger loses its reason.
  expect(Object.values(LEGACY_SERVICE_TO_REASON).filter(code => !isPauseReasonCode(code))).toEqual([]);
  expect(reasonFromLegacyService("windows-sandbox")).toBe("sandbox");
  expect(reasonFromLegacyService("worker-review")).toBe("worker-no-result");
  expect(reasonFromLegacyService("something-older")).toBeUndefined();
  expect(pauseActions(undefined)).toEqual([]);
  expect(pauseActions("worker-no-result")).toEqual(["redispatch", "review-directly", "ignore-worker"]);
});

test("pausing records the reason code in the state and in the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-pause-"));
  try {
    const ledger = await newTask(root);
    await ledger.needInput("Approve `bun test src/cart.test.ts`?", "approval");
    expect(ledger.state.pauseReason).toBe("approval");
    expect(ledger.state.pendingQuestion).toBe("Approve `bun test src/cart.test.ts`?");
    expect(checkTaskInvariants(ledger.state)).toEqual([]);

    const events = await readEvents(taskLogDir(ledger.file));
    expect(events.at(-1)).toMatchObject({ type: "status/changed", payload: { status: "needs-input", reason: "approval" } });
    expect(foldTask(events).pauseReason).toBe("approval");

    await ledger.resume("Approved");
    expect(ledger.state.pauseReason).toBeUndefined();
    expect(ledger.state.pendingQuestion).toBeUndefined();
    expect(ledger.state.status).toBe("active");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a pause without a reason code is an invariant violation", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-pause-codeless-"));
  try {
    const ledger = await newTask(root);
    await ledger.needInput("Which environment should the check run in?");
    expect(ledger.state.pauseReason).toBeUndefined();
    expect(checkTaskInvariants(ledger.state).map(item => item.code)).toContain("I6/needs-input-without-reason-code");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("stopping records why, and resuming clears it", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-stop-"));
  try {
    const ledger = await newTask(root);
    await recordApprovedPlan(ledger);
    await ledger.recordFailure("Model produced no response within 45000 ms");
    await ledger.stop("model");
    expect(ledger.state.stop?.reason).toBe("model");
    expect(ledger.state.stop?.detail).toBeUndefined();
    expect(ledger.state.stop?.stoppedAt).toBe(ledger.state.updatedAt);
    expect(checkTaskInvariants(ledger.state)).toEqual([]);

    const events = await readEvents(taskLogDir(ledger.file));
    expect(events.at(-1)).toMatchObject({ type: "status/changed", payload: { status: "stopped", reason: "model" } });
    expect(foldTask(events).stop?.reason).toBe("model");

    await ledger.resume("Model is back");
    expect(ledger.state.stop).toBeUndefined();
    expect(ledger.state.status).toBe("active");

    await ledger.stop("budget", "Task-wide model budget exhausted");
    expect(ledger.state.stop).toMatchObject({ reason: "budget", detail: "Task-wide model budget exhausted" });
    // Completing a task also clears the record, so a finished task never shows a stale stop reason.
    await ledger.resume("Budget raised");
    await ledger.recordEvidence({ criterionId: "check", kind: "test", passed: true, revision: ledger.state.revision!, source: "check.log" });
    await ledger.enableDevelopmentWorkflow();
    await ledger.recordDevelopmentReview({ verdict: "pass", findings: [], instanceId: "primary" });
    await ledger.complete();
    expect(ledger.state.stop).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an imported legacy ledger trades its service string for a reason code", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-legacy-pause-"));
  try {
    const id = "1f0a6c3e-6a4e-4c3a-9b1e-2f5c9d0a1b2d";
    const file = join(root, "data", "tasks", `${id}.json`);
    await mkdir(join(root, "data", "tasks"), { recursive: true });
    const state = legacyState(id, join(root, "project"), { blockedService: "MCP" });
    await writeFile(file, JSON.stringify(state, null, 2));

    const ledger = await TaskLedger.load(file);
    expect(ledger.state.pauseReason).toBe("approval");
    expect("blockedService" in ledger.state).toBe(false);
    expect(ledger.state.pendingQuestion).toBe("Approve the command?");
    expect(checkTaskInvariants(ledger.state)).toEqual([]);
    // The event log keeps the original value, so nothing is lost by normalizing the projection.
    const events = await readEvents(taskLogDir(file));
    const origin = events[0];
    expect(origin.type).toBe("task/imported");
    /** The imported snapshot still carries the pre-code field, which `TaskState` no longer declares. */
    const imported = (origin.type === "task/imported" ? origin.payload.state : {}) as TaskState & { blockedService?: string };
    expect(imported.blockedService).toBe("MCP");

    // A service string from an even older build has no code: the task stays paused and the invariant flags it.
    const unknownId = "2f0a6c3e-6a4e-4c3a-9b1e-2f5c9d0a1b2e";
    const unknownFile = join(root, "data", "tasks", `${unknownId}.json`);
    await writeFile(unknownFile, JSON.stringify(legacyState(unknownId, join(root, "project"), { blockedService: "carrier-pigeon" }), null, 2));
    const unknown = await TaskLedger.load(unknownFile);
    expect(unknown.state.pauseReason).toBeUndefined();
    expect(checkTaskInvariants(unknown.state).map(item => item.code)).toContain("I6/needs-input-without-reason-code");
    expect(await readFile(unknownFile, "utf8")).toContain("carrier-pigeon");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the continuation goal carries a revision that only moves forward", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-goal-revision-"));
  try {
    const ledger = await newTask(root);
    expect(ledger.state.goal?.revision).toBeUndefined();
    await ledger.setGoal(true, { maxToolCalls: 40, wallTimeMs: 600_000, maxTotalToolCalls: 120, totalWallTimeMs: 1_800_000 });
    expect(ledger.state.goal).toMatchObject({ enabled: true, revision: 1 });
    await ledger.setGoalProgress(1);
    expect(ledger.state.goal).toMatchObject({ noProgressRuns: 1, revision: 2 });
    await ledger.setGoalProgress(2, "no-progress");
    expect(ledger.state.goal).toMatchObject({ noProgressRuns: 2, stopReason: "no-progress", revision: 3 });

    const events = await readEvents(taskLogDir(ledger.file));
    expect(foldTask(events).goal?.revision).toBe(3);
    // A replayed or out-of-order goal event is refused instead of silently rewinding the continuation state.
    const goalEvents = events.filter(event => event.type === "goal/changed");
    const stale = [...events.slice(0, events.indexOf(goalEvents[2])), goalEvents[1]];
    expect(() => foldTask(stale.map((event, index) => ({ ...event, seq: index + 1 })))).toThrow(/does not follow/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("every stop reason code is accepted by the ledger and reported by the invariants", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-stop-codes-"));
  try {
    for (const reason of STOP_REASONS) {
      const ledger = await newTask(root, `project-${reason}`);
      await ledger.stop(reason);
      expect(ledger.state.stop?.reason).toBe(reason);
      expect(checkTaskInvariants(ledger.state)).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
