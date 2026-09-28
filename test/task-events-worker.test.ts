import { describe, expect, test } from "bun:test";
import type { AgentPresetSnapshot } from "../src/runtime/agent-presets";
import type { AgentRecord, CognitionState, CognitionStep, TaskState, WorkerCognition, WorkerRequestRecord } from "../src/runtime/task-ledger";
import { workerReducers } from "../src/runtime/task-events/apply/worker";
import { InvariantError } from "../src/runtime/task-events/errors";
import type { TaskEventOf, TaskEventType, TaskInstanceRecord } from "../src/runtime/task-events/types";
import type { WorkOrder } from "../src/runtime/work-orders";

const AT = "2026-09-28T00:00:00.000Z";
const T1 = "2026-09-28T01:00:00.000Z";
const T2 = "2026-09-28T02:00:00.000Z";

function baseState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    objective: "Ship the feature",
    projectRoot: "/srv/project",
    criteria: [],
    status: "active",
    revision: "rev-1",
    evidence: [],
    preview: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function apply<Type extends TaskEventType>(state: TaskState, type: Type, payload: TaskEventOf<Type>["payload"]): void {
  const reducer = workerReducers[type] as ((state: TaskState, event: TaskEventOf<Type>) => void) | undefined;
  if (!reducer) throw new Error(`workerReducers has no reducer for ${type}`);
  reducer(state, { seq: 1, at: T1, actor: "runtime", type, payload });
}

function expectInvariant(fn: () => void, code: string, message: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InvariantError);
  expect((thrown as InvariantError).code).toBe(code);
  expect((thrown as InvariantError).message).toBe(message);
}

function cognition(overrides: Partial<CognitionState> = {}): CognitionState {
  return { revision: 3, recipeVersion: 1, summary: "Plan", candidates: [], steps: [], gaps: [], amendments: [], ...overrides };
}

function step(id: string, overrides: Partial<CognitionStep> = {}): CognitionStep {
  return { id, objective: `objective ${id}`, mode: "implement", dependsOn: [], skillIds: [], status: "planned", ...overrides };
}

function instance(overrides: Partial<TaskInstanceRecord> = {}): TaskInstanceRecord {
  return { id: "w1", orderId: "step-1", mode: "implement", skills: [], contractVersion: 1, cognitionRevision: 1, baseRevision: null, status: "running", startedAt: AT, ...overrides };
}

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return { id: "agent-1", skillIds: [], mode: "implement", orderId: "step-1", lastAttemptId: "w1", status: "queued", ...overrides };
}

function order(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return { id: "step-1", objective: "Implement", ownedPaths: ["src/"], resources: [], acceptance: ["Tests pass"], ...overrides };
}

const preset: AgentPresetSnapshot = { id: "preset-1", name: "Expert", description: "d", instructions: "i", hash: "hash-1" };

function workerRequest(overrides: Partial<WorkerRequestRecord> = {}): WorkerRequestRecord {
  return { id: "req-1", agentId: "agent-1", runId: "w1", orderId: "step-1", kind: "capability", blockedStep: "step-1", capabilityIds: ["cap-1"], contractVersion: 1, sourceRevision: "rev-1", status: "open", recordedAt: AT, ...overrides };
}

function workerCognition(overrides: Partial<WorkerCognition> = {}): WorkerCognition {
  return { revision: 1, understanding: "Understood the task", findings: [], openQuestions: [], nextActions: [], sourceRevision: "rev-1", attemptId: "w1", updatedAt: T1, ...overrides };
}

const receipt = { id: "rc-1", attemptId: "w1", kind: "check" as const, sourceRevision: "rev-1", passed: true, path: "src/a.ts", recordedAt: AT };

describe("worker/dispatched", () => {
  test("records the instance from payload values and marks the plan step running", () => {
    const state = baseState({ contractVersion: 2, cognition: cognition({ steps: [step("step-1")] }) });
    const skills = [{ id: "sk-1", hash: "h", revision: "r" }];
    apply(state, "worker/dispatched", { id: "w1", orderId: "step-1", mode: "implement", skills, startedAt: T1 });
    const instances = state.cognition!.instances!;
    expect(instances).toHaveLength(1);
    expect(instances[0]).toEqual({ id: "w1", orderId: "step-1", mode: "implement", skills: [{ id: "sk-1", hash: "h", revision: "r" }], contractVersion: 2, cognitionRevision: 3, baseRevision: "rev-1", status: "running", startedAt: T1 });
    expect(instances[0].skills[0]).not.toBe(skills[0]);
    expect(Object.keys(instances[0])).toEqual(["id", "orderId", "mode", "skills", "contractVersion", "cognitionRevision", "baseRevision", "status", "startedAt"]);
    expect(state.cognition!.steps[0].status).toBe("running");
    expect(state.cognition!.steps[0].statusReason).toBe("工单 w1 运行中");
  });

  test("a repeated attempt id is a silent no-op", () => {
    const state = baseState({ cognition: cognition({ steps: [step("step-1")] }) });
    apply(state, "worker/dispatched", { id: "w1", orderId: "step-1", mode: "implement", skills: [], startedAt: T1 });
    state.cognition!.steps[0].statusReason = "later edit";
    apply(state, "worker/dispatched", { id: "w1", orderId: "step-1", mode: "implement", skills: [], startedAt: T2 });
    expect(state.cognition!.instances).toHaveLength(1);
    expect(state.cognition!.instances![0].startedAt).toBe(T1);
    expect(state.cognition!.steps[0].statusReason).toBe("later edit");
  });

  test("creates the default cognition when the task has none", () => {
    const state = baseState();
    apply(state, "worker/dispatched", { id: "w1", orderId: "step-1", mode: "implement", skills: [], startedAt: T1 });
    expect(Object.keys(state.cognition!)).toEqual(["revision", "recipeVersion", "summary", "candidates", "steps", "gaps", "amendments", "instances"]);
    const { instances, ...rest } = state.cognition!;
    expect(rest).toEqual({ revision: 1, recipeVersion: 1, summary: "Ship the feature", candidates: [], steps: [], gaps: [], amendments: [] });
    expect(instances).toHaveLength(1);
  });

  test("reserved order ids never touch a plan step", () => {
    const state = baseState({ cognition: cognition({ steps: [step("coordinator")] }) });
    apply(state, "worker/dispatched", { id: "w1", orderId: "coordinator", mode: "review", skills: [], startedAt: T1 });
    expect(state.cognition!.instances).toHaveLength(1);
    expect(state.cognition!.steps[0].status).toBe("planned");
    expect(state.cognition!.steps[0].statusReason).toBeUndefined();
  });

  test("a task that is not active is rejected before any mutation", () => {
    const state = baseState({ status: "stopped" });
    expectInvariant(
      () => apply(state, "worker/dispatched", { id: "w1", orderId: "step-1", mode: "implement", skills: [], startedAt: T1 }),
      "apply/task-not-active",
      "Task is stopped",
    );
    expect(state.cognition).toBeUndefined();
  });
});

describe("worker/queued", () => {
  test("upserts a new agent record and queues the instance", () => {
    const state = baseState({ contractVersion: 4, cognition: cognition({ steps: [step("step-1")] }) });
    const workOrder = order({ agentId: "agent-1", skillIds: ["sk-1"], capabilityIds: ["cap-1"], contextRevision: 2, decisionReason: "because", mode: "implement" });
    const expert = { id: "e-1", name: "Expert", hash: "hash-1" };
    apply(state, "worker/queued", { attemptId: "w1", parentId: "p0", order: workOrder, preset, expert, startedAt: T1 });
    expect(state.cognition!.agents).toEqual([{ id: "agent-1", expert: preset, skillIds: ["sk-1"], capabilityIds: ["cap-1"], contextRevision: 2, mode: "implement", orderId: "step-1", lastAttemptId: "w1", status: "queued" }]);
    const queued = state.cognition!.instances![0];
    expect(queued).toEqual({ id: "w1", agentId: "agent-1", parentId: "p0", orderId: "step-1", order: workOrder, decisionReason: "because", mode: "implement", expert, skills: [], contractVersion: 4, cognitionRevision: 3, baseRevision: "rev-1", status: "queued", startedAt: T1 });
    expect(queued.order).toBe(workOrder);
    expect(Object.keys(queued)).toEqual(["id", "agentId", "parentId", "orderId", "order", "decisionReason", "mode", "expert", "skills", "contractVersion", "cognitionRevision", "baseRevision", "status", "startedAt"]);
    expect(state.cognition!.steps[0].status).toBe("running");
    expect(state.cognition!.steps[0].statusReason).toBe("工单 w1 排队中");
  });

  test("a duplicate attempt id throws before any queue work", () => {
    const state = baseState({ cognition: cognition({ instances: [instance({ id: "w1", status: "queued" })] }) });
    expectInvariant(
      () => apply(state, "worker/queued", { attemptId: "w1", order: order({ agentId: "agent-1", acceptance: undefined, ownedPaths: [] }), startedAt: T1 }),
      "apply/worker-attempt-exists",
      "Worker attempt already exists",
    );
    expect(state.cognition!.agents).toBeUndefined();
    expect(state.cognition!.instances).toHaveLength(1);
  });

  test("a neutral subagent requires acceptance criteria and a source scope", () => {
    const state = baseState({ cognition: cognition() });
    expectInvariant(
      () => apply(state, "worker/queued", { attemptId: "w1", order: order({ agentId: "agent-1", acceptance: undefined }), startedAt: T1 }),
      "apply/neutral-subagent-underspecified",
      "Neutral subagent requires acceptance criteria and source scope",
    );
    expectInvariant(
      () => apply(state, "worker/queued", { attemptId: "w1", order: order({ agentId: "agent-1", ownedPaths: [] }), startedAt: T1 }),
      "apply/neutral-subagent-underspecified",
      "Neutral subagent requires acceptance criteria and source scope",
    );
    // readPaths alone provide the scope
    apply(state, "worker/queued", { attemptId: "w1", order: order({ agentId: "agent-1", ownedPaths: [], readPaths: ["docs/"] }), startedAt: T1 });
    expect(state.cognition!.instances).toHaveLength(1);
  });

  test("a continuation supersedes a returned attempt", () => {
    const previous = instance({ id: "w0", status: "returned", findings: ["earlier finding"] });
    const state = baseState({
      cognition: cognition({
        agents: [agentRecord({ status: "returned", lastAttemptId: "w0", contextRevision: 5, capabilityIds: ["old"] })],
        instances: [previous],
        steps: [step("step-1")],
      }),
    });
    apply(state, "worker/queued", { attemptId: "w1", order: order({ agentId: "agent-1", mode: "review" }), startedAt: T1 });
    expect(previous.status).toBe("cancelled");
    expect(previous.findings).toEqual(["earlier finding", "Superseded by continuation"]);
    expect(previous.endedAt).toBe(T1);
    const record = state.cognition!.agents![0];
    expect(record.lastAttemptId).toBe("w1");
    expect(record.status).toBe("queued");
    expect(record.mode).toBe("review");
    expect(record.capabilityIds).toEqual([]);
    expect(record.contextRevision).toBe(5);
    expect(state.cognition!.agents).toHaveLength(1);
    expect(state.cognition!.instances).toHaveLength(2);
    expect(state.cognition!.instances![1].status).toBe("queued");
    expect(state.cognition!.steps[0].status).toBe("running");
    expect(state.cognition!.steps[0].statusReason).toBe("工单 w1 排队中");
  });

  test("identity, expert or skill changes on an existing agent are rejected", () => {
    const state = baseState({ cognition: cognition({ agents: [agentRecord({ status: "returned", expert: preset, skillIds: ["sk-1"] })] }) });
    expectInvariant(
      () => apply(state, "worker/queued", { attemptId: "w1", order: order({ agentId: "agent-1", skillIds: ["sk-1"] }), preset: { ...preset, hash: "hash-2" }, startedAt: T1 }),
      "apply/subagent-identity-changed",
      "Subagent identity or expert/skills changed",
    );
    expectInvariant(
      () => apply(state, "worker/queued", { attemptId: "w1", order: order({ id: "step-2", agentId: "agent-1", skillIds: ["sk-1"] }), preset, startedAt: T1 }),
      "apply/subagent-identity-changed",
      "Subagent identity or expert/skills changed",
    );
    expectInvariant(
      () => apply(state, "worker/queued", { attemptId: "w1", order: order({ agentId: "agent-1", skillIds: ["sk-2"] }), preset, startedAt: T1 }),
      "apply/subagent-identity-changed",
      "Subagent identity or expert/skills changed",
    );
    expect(state.cognition!.instances).toBeUndefined();
  });

  test("queueing while the subagent is already running is rejected", () => {
    const state = baseState({ cognition: cognition({ agents: [agentRecord({ status: "running" })] }) });
    expectInvariant(
      () => apply(state, "worker/queued", { attemptId: "w2", order: order({ agentId: "agent-1" }), startedAt: T1 }),
      "apply/subagent-already-running",
      "Subagent is already running",
    );
    expect(state.cognition!.instances).toBeUndefined();
  });
});

describe("worker/updated", () => {
  function fixture() {
    const workOrder = order({ agentId: "agent-1", skillSnapshots: [{ id: "old", hash: "h", revision: "r" }] });
    const state = baseState({
      cognition: cognition({
        instances: [instance({ id: "w1", agentId: "agent-1", order: workOrder })],
        agents: [agentRecord({ id: "agent-1", status: "queued", lastAttemptId: "w1" })],
        steps: [step("step-1")],
      }),
    });
    return { state, workOrder };
  }

  test("mirrors status, cognition, skills and capabilities onto the agent and the order", () => {
    const { state, workOrder } = fixture();
    const cognitionPatch = { revision: 2, understanding: "u", findings: [], openQuestions: [], nextActions: [], sourceRevision: null };
    const skills = [{ id: "sk-1", hash: "h1", revision: "r1" }];
    const capabilities = [{ id: "cap-1", kind: "skill" as const, revision: "2" }];
    apply(state, "worker/updated", { id: "w1", status: "blocked", patch: { cognition: cognitionPatch, skills, capabilities, integration: "conflict" }, endedAt: T2 });
    const record = state.cognition!.instances![0];
    const mirrored = state.cognition!.agents![0];
    expect(record.status).toBe("blocked");
    expect(record.integration).toBe("conflict");
    expect(record.endedAt).toBe(T2);
    expect(mirrored.status).toBe("waiting-primary");
    expect(mirrored.cognition).toBe(cognitionPatch);
    expect(mirrored.skillIds).toEqual(["sk-1"]);
    expect(mirrored.skillSnapshots).toEqual(skills);
    expect(mirrored.skillSnapshots![0]).not.toBe(skills[0]);
    expect(workOrder.skillSnapshots).toEqual(skills);
    expect(workOrder.skillSnapshots![0]).not.toBe(skills[0]);
    expect(workOrder.skillSnapshots![0]).not.toBe(mirrored.skillSnapshots![0]);
    expect(mirrored.capabilitySnapshots).toEqual(capabilities);
    expect(mirrored.capabilitySnapshots![0]).not.toBe(capabilities[0]);
    expect(workOrder.capabilitySnapshots).toEqual(capabilities);
    expect(state.cognition!.steps[0].status).toBe("blocked");
    expect(state.cognition!.steps[0].statusReason).toBe("工单 w1 blocked / conflict");
  });

  test("a running update leaves endedAt unset and keeps the step running", () => {
    const { state } = fixture();
    apply(state, "worker/updated", { id: "w1", status: "running", patch: { workRoot: "/tmp/work" } });
    const record = state.cognition!.instances![0];
    expect(record.workRoot).toBe("/tmp/work");
    expect(record.endedAt).toBeUndefined();
    expect(state.cognition!.agents![0].status).toBe("running");
    expect(state.cognition!.steps[0].status).toBe("running");
    expect(state.cognition!.steps[0].statusReason).toBe("工单 w1 running");
  });

  test("an already ended attempt is a silent no-op", () => {
    const { state } = fixture();
    state.cognition!.instances![0].status = "completed";
    const before = structuredClone(state);
    apply(state, "worker/updated", { id: "w1", status: "failed", patch: { findings: ["late"] }, endedAt: T2 });
    expect(state).toEqual(before);
  });

  test("unknown attempts and attempts without an order are rejected", () => {
    const { state } = fixture();
    expectInvariant(() => apply(state, "worker/updated", { id: "w9", status: "running", patch: {} }), "apply/worker-attempt-missing", "Worker attempt not found");
    delete state.cognition!.instances![0].order;
    expectInvariant(() => apply(state, "worker/updated", { id: "w1", status: "running", patch: {} }), "apply/worker-attempt-missing", "Worker attempt not found");
  });

  test("an agent whose lastAttemptId moved on is not mirrored", () => {
    const { state } = fixture();
    state.cognition!.agents![0].lastAttemptId = "w0";
    apply(state, "worker/updated", { id: "w1", status: "completed", patch: { findings: ["done"] }, endedAt: T2 });
    expect(state.cognition!.agents![0].status).toBe("queued");
    expect(state.cognition!.instances![0].status).toBe("completed");
    expect(state.cognition!.instances![0].findings).toEqual(["done"]);
    expect(state.cognition!.steps[0].status).toBe("complete");
    expect(state.cognition!.steps[0].statusReason).toBe("工单 w1 completed");
  });
});

describe("worker-cognition/updated", () => {
  test("assigns the payload cognition once the guards pass", () => {
    const state = baseState({ workerReceipts: [receipt] });
    const next = workerCognition({ findings: [{ text: "Saw it", evidence: ["rc-1"] }] });
    apply(state, "worker-cognition/updated", { cognition: next });
    expect(state.workerCognition).toBe(next);
  });

  test("blank or oversized cognition is rejected", () => {
    const state = baseState();
    expectInvariant(
      () => apply(state, "worker-cognition/updated", { cognition: workerCognition({ understanding: "   " }) }),
      "apply/worker-cognition-invalid",
      "Worker cognition is invalid or too large",
    );
    expectInvariant(
      () => apply(state, "worker-cognition/updated", { cognition: workerCognition({ understanding: "x".repeat(2001) }) }),
      "apply/worker-cognition-invalid",
      "Worker cognition is invalid or too large",
    );
    expectInvariant(
      () => apply(state, "worker-cognition/updated", { cognition: workerCognition({ findings: Array.from({ length: 21 }, () => ({ text: "t", evidence: [] })) }) }),
      "apply/worker-cognition-invalid",
      "Worker cognition is invalid or too large",
    );
    expect(state.workerCognition).toBeUndefined();
  });

  test("a finding that is blank, oversized or cites an unknown receipt is rejected", () => {
    const state = baseState({ workerReceipts: [receipt] });
    expectInvariant(
      () => apply(state, "worker-cognition/updated", { cognition: workerCognition({ findings: [{ text: "t", evidence: ["rc-9"] }] }) }),
      "apply/worker-citation-unknown",
      "Worker finding cites an unknown evidence receipt",
    );
    expectInvariant(
      () => apply(state, "worker-cognition/updated", { cognition: workerCognition({ findings: [{ text: " ", evidence: [] }] }) }),
      "apply/worker-citation-unknown",
      "Worker finding cites an unknown evidence receipt",
    );
    expectInvariant(
      () => apply(state, "worker-cognition/updated", { cognition: workerCognition({ findings: [{ text: "x".repeat(501), evidence: [] }] }) }),
      "apply/worker-citation-unknown",
      "Worker finding cites an unknown evidence receipt",
    );
    expect(state.workerCognition).toBeUndefined();
  });

  test("a task that is not active is rejected", () => {
    const state = baseState({ status: "needs-input" });
    expectInvariant(
      () => apply(state, "worker-cognition/updated", { cognition: workerCognition() }),
      "apply/task-not-active",
      "Task is needs-input",
    );
  });
});

describe("worker-receipt/recorded", () => {
  test("initializes workerReceipts and appends in order", () => {
    const state = baseState();
    apply(state, "worker-receipt/recorded", { receipt });
    apply(state, "worker-receipt/recorded", { receipt: { ...receipt, id: "rc-2" } });
    expect(state.workerReceipts).toEqual([receipt, { ...receipt, id: "rc-2" }]);
  });
});

describe("worker-request/recorded", () => {
  test("a request without a matching run instance is rejected", () => {
    const state = baseState({ cognition: cognition({ instances: [instance({ id: "w1", agentId: "agent-2" })] }) });
    expectInvariant(() => apply(state, "worker-request/recorded", { request: workerRequest() }), "apply/worker-request-no-run", "Worker request has no matching run");
    expect(state.workerRequests).toBeUndefined();
  });

  test("a new request is appended verbatim", () => {
    const state = baseState({ cognition: cognition({ instances: [instance({ id: "w1", agentId: "agent-1" })] }) });
    const request = workerRequest({ status: "open", recordedAt: T1 });
    apply(state, "worker-request/recorded", { request });
    expect(state.workerRequests).toHaveLength(1);
    expect(state.workerRequests![0]).toBe(request);
  });

  test("an identical replay is silent and leaves the stored record alone", () => {
    const state = baseState({
      cognition: cognition({ instances: [instance({ id: "w1", agentId: "agent-1" })] }),
      workerRequests: [workerRequest({ status: "applied", resolvedAt: T1 })],
    });
    apply(state, "worker-request/recorded", { request: workerRequest({ status: "open" }) });
    expect(state.workerRequests).toHaveLength(1);
    expect(state.workerRequests![0].status).toBe("applied");
  });

  test("reusing an id with different fields is rejected", () => {
    const state = baseState({
      cognition: cognition({ instances: [instance({ id: "w1", agentId: "agent-1" })] }),
      workerRequests: [workerRequest()],
    });
    expectInvariant(
      () => apply(state, "worker-request/recorded", { request: workerRequest({ sourceRevision: "rev-2" }) }),
      "apply/worker-request-id-reused",
      "Worker request ID was reused",
    );
    expectInvariant(
      () => apply(state, "worker-request/recorded", { request: workerRequest({ kind: "permission" }) }),
      "apply/worker-request-id-reused",
      "Worker request ID was reused",
    );
    expect(state.workerRequests).toHaveLength(1);
  });
});

describe("worker-request/updated", () => {
  test("resolving stamps resolvedAt from the payload", () => {
    const state = baseState({ workerRequests: [workerRequest()] });
    apply(state, "worker-request/updated", { id: "req-1", patch: { status: "applied", reason: "installed", resolutionRunId: "run-9" }, resolvedAt: T2, clearResolvedAt: false });
    expect(state.workerRequests![0]).toMatchObject({ status: "applied", reason: "installed", resolutionRunId: "run-9", resolvedAt: T2 });
  });

  test("uncertain stamps resolvedAt too, and leaving uncertain clears it when asked", () => {
    const state = baseState({ workerRequests: [workerRequest()] });
    apply(state, "worker-request/updated", { id: "req-1", patch: { status: "uncertain", reason: "not sure" }, resolvedAt: T2, clearResolvedAt: false });
    expect(state.workerRequests![0].resolvedAt).toBe(T2);
    apply(state, "worker-request/updated", { id: "req-1", patch: { status: "open" }, clearResolvedAt: true });
    expect(state.workerRequests![0].status).toBe("open");
    expect("resolvedAt" in state.workerRequests![0]).toBe(false);
  });

  test("without clearResolvedAt the timestamp survives a status patch", () => {
    const state = baseState({ workerRequests: [workerRequest({ status: "uncertain", resolvedAt: T1 })] });
    apply(state, "worker-request/updated", { id: "req-1", patch: { status: "awaiting-approval" }, clearResolvedAt: false });
    expect(state.workerRequests![0].resolvedAt).toBe(T1);
  });

  test("unknown or already resolved requests are rejected", () => {
    const state = baseState({ workerRequests: [workerRequest({ status: "rejected", resolvedAt: T1 })] });
    expectInvariant(
      () => apply(state, "worker-request/updated", { id: "req-9", patch: { status: "applied" }, clearResolvedAt: false }),
      "apply/worker-request-missing",
      "Worker request not found",
    );
    expectInvariant(
      () => apply(state, "worker-request/updated", { id: "req-1", patch: { status: "applied" }, clearResolvedAt: false }),
      "apply/worker-request-resolved",
      "Worker request is already resolved",
    );
    expect(state.workerRequests![0]).toMatchObject({ status: "rejected", resolvedAt: T1 });
  });
});

describe("worker-run/prepared", () => {
  test("a completed task cannot be continued", () => {
    const state = baseState({ status: "complete" });
    expectInvariant(() => apply(state, "worker-run/prepared", {}), "apply/worker-run-on-complete", "Completed worker state cannot be continued");
    expect(state.status).toBe("complete");
  });

  test("reactivates and clears the blocking context", () => {
    const state = baseState({
      status: "needs-input",
      pendingQuestion: "?",
      pauseReason: "worker-no-result",
      stop: { reason: "no-progress", stoppedAt: "2026-09-28T00:30:00.000Z" },
      workerOutcome: { status: "blocked", findings: ["f"] },
    });
    apply(state, "worker-run/prepared", {});
    expect(state.status).toBe("active");
    expect("pendingQuestion" in state).toBe(false);
    expect("pauseReason" in state).toBe(false);
    expect("stop" in state).toBe(false);
    expect("workerOutcome" in state).toBe(false);
  });
});

describe("worker/finished", () => {
  test("completes a running instance and joins the findings on the step", () => {
    const state = baseState({ cognition: cognition({ instances: [instance()], steps: [step("step-1", { status: "running" })] }) });
    apply(state, "worker/finished", { id: "w1", status: "completed", findings: ["did A", "did B"], endedAt: T2 });
    expect(state.cognition!.instances![0]).toMatchObject({ status: "completed", findings: ["did A", "did B"], endedAt: T2 });
    expect(state.cognition!.steps[0].status).toBe("complete");
    expect(state.cognition!.steps[0].statusReason).toBe("did A；did B");
  });

  test("empty findings fall back to the order message; failed blocks and cancelled cancels the step", () => {
    const state = baseState({ cognition: cognition({ instances: [instance()], steps: [step("step-1")] }) });
    apply(state, "worker/finished", { id: "w1", status: "failed", findings: [], endedAt: T2 });
    expect(state.cognition!.steps[0].status).toBe("blocked");
    expect(state.cognition!.steps[0].statusReason).toBe("工单 w1 failed");
    const second = baseState({ cognition: cognition({ instances: [instance()], steps: [step("step-1")] }) });
    apply(second, "worker/finished", { id: "w1", status: "cancelled", findings: [], endedAt: T2 });
    expect(second.cognition!.steps[0].status).toBe("cancelled");
    expect(second.cognition!.steps[0].statusReason).toBe("工单 w1 cancelled");
  });

  test("unknown or non-running instances are a silent no-op", () => {
    const state = baseState({ cognition: cognition({ instances: [instance({ status: "queued" })], steps: [step("step-1")] }) });
    const before = structuredClone(state);
    apply(state, "worker/finished", { id: "w1", status: "completed", findings: ["x"], endedAt: T2 });
    apply(state, "worker/finished", { id: "w9", status: "completed", findings: ["x"], endedAt: T2 });
    expect(state).toEqual(before);
  });

  test("reserved order ids finish the instance without touching a step", () => {
    const state = baseState({ cognition: cognition({ instances: [instance({ orderId: "final-review" })], steps: [step("final-review")] }) });
    apply(state, "worker/finished", { id: "w1", status: "completed", findings: ["ok"], endedAt: T2 });
    expect(state.cognition!.instances![0].status).toBe("completed");
    expect(state.cognition!.steps[0].status).toBe("planned");
  });
});

describe("workers/reconciled", () => {
  test("fails queued and running instances and blocks their steps", () => {
    const state = baseState({
      cognition: cognition({
        instances: [
          instance({ id: "w1", status: "running" }),
          instance({ id: "w2", status: "queued", orderId: "step-2" }),
          instance({ id: "w3", status: "completed", orderId: "step-3" }),
        ],
        steps: [step("step-1", { status: "running", statusReason: "工单 w1 运行中" }), step("step-2"), step("step-3", { status: "complete" })],
      }),
    });
    apply(state, "workers/reconciled", { reason: "Coordinator restarted", endedAt: T2 });
    const [w1, w2, w3] = state.cognition!.instances!;
    expect(w1).toMatchObject({ status: "failed", findings: ["Coordinator restarted"], endedAt: T2 });
    expect(w2).toMatchObject({ status: "failed", findings: ["Coordinator restarted"], endedAt: T2 });
    expect(w3.status).toBe("completed");
    expect(w3.findings).toBeUndefined();
    const steps = state.cognition!.steps;
    expect(steps[0].status).toBe("blocked");
    expect(steps[0].statusReason).toBe("工单 w1 运行中");
    expect(steps[1].status).toBe("blocked");
    expect(steps[2].status).toBe("complete");
  });

  test("nothing queued or running is a silent no-op", () => {
    const state = baseState({ cognition: cognition({ instances: [instance({ status: "completed" })], steps: [step("step-1", { status: "complete" })] }) });
    const before = structuredClone(state);
    apply(state, "workers/reconciled", { reason: "r", endedAt: T2 });
    expect(state).toEqual(before);
  });
});

describe("worker-outcome/recorded", () => {
  test("keeps previous requests when the outcome carries none, and trims findings", () => {
    const priorRequests = [{ capability: "c", reason: "r", details: "d" }];
    const state = baseState({ workerOutcome: { status: "failed", findings: ["old"], requests: priorRequests } });
    apply(state, "worker-outcome/recorded", { outcome: { status: "completed", findings: ["  kept  ", "", "also"], reviewVerdict: "pass" } });
    expect(state.workerOutcome).toEqual({ status: "completed", findings: ["kept", "also"], reviewVerdict: "pass", requests: priorRequests });
    expect(state.workerOutcome!.requests).toBe(priorRequests);
    expect(Object.keys(state.workerOutcome!)).toEqual(["status", "findings", "reviewVerdict", "requests"]);
  });

  test("an explicit requests list replaces the previous one", () => {
    const state = baseState({ workerOutcome: { status: "failed", findings: [], requests: [{ capability: "c", reason: "r", details: "d" }] } });
    apply(state, "worker-outcome/recorded", { outcome: { status: "needs-context", findings: [], requests: [] } });
    expect(state.workerOutcome!.requests).toEqual([]);
  });

  test("a task that is not active is rejected", () => {
    const state = baseState({ status: "stopped" });
    expectInvariant(
      () => apply(state, "worker-outcome/recorded", { outcome: { status: "completed", findings: [] } }),
      "apply/task-not-active",
      "Task is stopped",
    );
    expect(state.workerOutcome).toBeUndefined();
  });
});
