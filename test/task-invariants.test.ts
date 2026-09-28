import { expect, test } from "bun:test";
import { checkTaskInvariants, KNOWN_PAUSE_REASONS } from "../src/runtime/task-invariants";
import type { CognitionState, Evidence, TaskState } from "../src/runtime/task-ledger";

const revision = "a".repeat(64);
const otherRevision = "b".repeat(64);
const now = "2026-09-28T08:00:00.000Z";

function cognition(overrides: Partial<CognitionState> = {}): CognitionState {
  return {
    revision: 2,
    recipeVersion: 1,
    summary: "Inspect the cart total, then fix rounding",
    candidates: ["backend"],
    steps: [],
    gaps: [],
    amendments: [{ revision: 2, reason: "Split the fix into two steps", affectedSteps: ["s1"], recordedAt: now }],
    ...overrides,
  };
}

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { id: "e1", criterionId: "check", kind: "test", revision, contractVersion: 1, passed: true, source: "alpha_check test", recordedAt: now, ...overrides };
}

/** A ledger that satisfies every invariant; each test bends exactly one field. */
function cleanState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    taskType: "code-change",
    objective: "Fix the cart total rounding",
    contractVersion: 1,
    contractHistory: [],
    guidanceHistory: [],
    cognition: cognition(),
    projectRoot: "/tmp/project",
    criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }],
    status: "active",
    phase: "execute",
    revision,
    evidence: [],
    runs: [],
    preview: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function acceptedState(): TaskState {
  return cleanState({ status: "complete", phase: undefined, evidence: [evidence()] });
}

test("an active ledger with a consistent plan has no violations", () => {
  expect(checkTaskInvariants(cleanState())).toEqual([]);
  expect(checkTaskInvariants(acceptedState())).toEqual([]);
});

test("every known pause reason is accepted while an unknown one is reported", () => {
  for (const reason of KNOWN_PAUSE_REASONS) {
    const state = cleanState({ status: "needs-input", pendingQuestion: "Approve the command?", blockedService: reason });
    expect(checkTaskInvariants(state)).toEqual([]);
  }
  const violations = checkTaskInvariants(cleanState({ status: "needs-input", pendingQuestion: "Approve?", blockedService: "something-new" }));
  expect(violations.map(item => item.code)).toEqual(["I6/unknown-reason-code"]);
});

test("a pause without a question or without a reason code is a violation", () => {
  expect(checkTaskInvariants(cleanState({ status: "needs-input", blockedService: "approval" })).map(item => item.code))
    .toEqual(["I6/needs-input-without-question"]);
  expect(checkTaskInvariants(cleanState({ status: "needs-input", pendingQuestion: "Approve?" })).map(item => item.code))
    .toEqual(["I6/needs-input-without-reason-code"]);
});

test("pause fields left behind on a running task are reported", () => {
  const violations = checkTaskInvariants(cleanState({ pendingQuestion: "Approve?", blockedService: "approval" }));
  expect(violations.map(item => item.code)).toEqual(["S/leftover-pause-fields"]);
});

test("an operation journal entry still running for a paused task is a stale lock", () => {
  const operations = [{ taskId: "task-1", runId: "run-1", status: "running" as const }];
  expect(checkTaskInvariants(cleanState(), operations)).toEqual([]);
  const stopped = checkTaskInvariants(cleanState({ status: "stopped", lastFailure: "User cancelled" }), operations);
  expect(stopped.map(item => item.code)).toEqual(["I2/stale-operation-lock"]);
  expect(checkTaskInvariants(cleanState(), [{ taskId: "other", runId: "run-1", status: "running" }])).toEqual([]);
});

test("a complete task with unclosed acceptance gaps is reported", () => {
  const withoutEvidence = checkTaskInvariants(cleanState({ status: "complete", phase: undefined }));
  expect(withoutEvidence.map(item => item.code)).toEqual(["I3/complete-without-current-evidence"]);
  expect(withoutEvidence[0].message).toContain("check");
  const staleRevision = checkTaskInvariants({ ...acceptedState(), evidence: [evidence({ revision: otherRevision })] });
  expect(staleRevision.map(item => item.code)).toEqual(["I3/complete-without-current-evidence"]);
  const staleContract = checkTaskInvariants({ ...acceptedState(), contractVersion: 2, evidence: [evidence()] });
  expect(staleContract.map(item => item.code)).toEqual(["I3/complete-without-current-evidence", "I4/contract-history-incomplete"]);
});

test("contract versions must increase by one and never come from the future", () => {
  const revised = cleanState({
    contractVersion: 3,
    contractHistory: [
      { version: 1, objective: "first", revisedAt: now },
      { version: 2, objective: "second", revisedAt: now },
    ],
  });
  expect(checkTaskInvariants(revised)).toEqual([]);
  expect(checkTaskInvariants({ ...revised, contractHistory: [{ version: 2, objective: "second", revisedAt: now }, { version: 2, objective: "again", revisedAt: now }] }).map(item => item.code))
    .toContain("I4/contract-history-not-monotonic");
  expect(checkTaskInvariants({ ...revised, contractHistory: [{ version: 3, objective: "current", revisedAt: now }] }).map(item => item.code))
    .toContain("I4/contract-history-not-past");
  expect(checkTaskInvariants({ ...revised, contractHistory: [{ version: 1, objective: "first", revisedAt: now }] }).map(item => item.code))
    .toEqual(["I4/contract-version-gap", "I4/contract-history-incomplete"]);
  expect(checkTaskInvariants({ ...revised, evidence: [evidence({ contractVersion: 4 })] }).map(item => item.code))
    .toContain("I4/evidence-from-future-contract");
  expect(checkTaskInvariants({ ...revised, runs: [{ model: "test/model", toolCalls: 1, maxToolCalls: 10, wallTimeMs: 1000, elapsedMs: 500, contractVersion: 9, outcome: "returned", recordedAt: now }] }).map(item => item.code))
    .toContain("I4/run-from-future-contract");
});

test("worker records must point at real, ended attempts", () => {
  const instance = {
    id: "attempt-1", agentId: "agent-1", orderId: "s1", mode: "implement" as const, skills: [], contractVersion: 1,
    cognitionRevision: 2, baseRevision: revision, status: "completed" as const, startedAt: now, endedAt: now,
  };
  const state = cleanState({ cognition: cognition({ steps: [{ id: "s1", objective: "fix", mode: "implement", dependsOn: [], skillIds: [], status: "complete", statusReason: "done" }], instances: [instance], agents: [{ id: "agent-1", skillIds: [], mode: "implement", orderId: "s1", lastAttemptId: "attempt-1", status: "completed" }] }) });
  expect(checkTaskInvariants(state)).toEqual([]);

  const request = { id: "req-1", agentId: "agent-1", runId: "attempt-x", orderId: "s1", kind: "capability" as const, blockedStep: "s1", capabilityIds: [], contractVersion: 1, sourceRevision: revision, status: "open" as const, recordedAt: now };
  expect(checkTaskInvariants({ ...state, workerRequests: [request] }).map(item => item.code)).toContain("I5/worker-request-without-instance");
  expect(checkTaskInvariants({ ...state, workerRequests: [{ ...request, runId: "attempt-1" }] })).toEqual([]);

  const running = { ...instance, status: "running" as const, integration: "merged" as const };
  expect(checkTaskInvariants(cleanState({ cognition: cognition({ instances: [running] }) })).map(item => item.code)).toContain("I5/integration-without-result");
  const returned = { ...instance, status: "returned" as const, integration: "pending" as const };
  expect(checkTaskInvariants(cleanState({ cognition: cognition({ instances: [returned] }) })).map(item => item.code)).not.toContain("I5/integration-without-result");

  const unknownAgent = cleanState({ cognition: cognition({ agents: [{ id: "agent-1", skillIds: [], mode: "implement", orderId: "s1", lastAttemptId: "missing", status: "completed" }] }) });
  expect(checkTaskInvariants(unknownAgent).map(item => item.code)).toContain("I5/agent-attempt-unknown");
  const mismatched = cleanState({ cognition: cognition({ instances: [instance], agents: [{ id: "agent-1", skillIds: [], mode: "implement", orderId: "s1", lastAttemptId: "attempt-1", status: "running" }] }) });
  expect(checkTaskInvariants(mismatched).map(item => item.code)).toContain("I5/agent-status-mismatch");
  const blocked = cleanState({ cognition: cognition({ instances: [{ ...instance, status: "blocked" as const }], agents: [{ id: "agent-1", skillIds: [], mode: "implement", orderId: "s1", lastAttemptId: "attempt-1", status: "waiting-primary" }] }) });
  expect(checkTaskInvariants(blocked)).toEqual([]);

  const reviewed = cleanState({ development: { enabled: true, repairAttempts: 0, review: { verdict: "pass", findings: [], revision, contractVersion: 1, instanceId: "attempt-x", recordedAt: now } } });
  expect(checkTaskInvariants(reviewed).map(item => item.code)).toContain("I5/review-without-instance");
});

test("cognition and plan revisions never run ahead of the ledger", () => {
  expect(checkTaskInvariants(cleanState({ cognition: cognition({ revision: 2, amendments: [{ revision: 3, reason: "later", affectedSteps: [], recordedAt: now }] }) })).map(item => item.code))
    .toContain("I7/amendment-ahead-of-cognition");
  expect(checkTaskInvariants(cleanState({ cognition: cognition({ revision: 3, amendments: [{ revision: 3, reason: "a", affectedSteps: [], recordedAt: now }, { revision: 2, reason: "b", affectedSteps: [], recordedAt: now }] }) })).map(item => item.code))
    .toContain("I7/amendment-revision-not-monotonic");
  const instance = { id: "attempt-1", orderId: "s1", mode: "implement" as const, skills: [], contractVersion: 1, cognitionRevision: 7, baseRevision: revision, status: "completed" as const, startedAt: now };
  expect(checkTaskInvariants(cleanState({ cognition: cognition({ instances: [instance] }) })).map(item => item.code))
    .toContain("I7/instance-ahead-of-cognition");
  expect(checkTaskInvariants(cleanState({ goal: { enabled: true, noProgressRuns: -1 } })).map(item => item.code))
    .toEqual(["I7/negative-no-progress-runs"]);
});

test("a plan approval belongs to the current execute phase, revision and contract", () => {
  const approval = { contractVersion: 1, cognitionRevision: 2, sourceRevision: revision, approvedAt: now };
  expect(checkTaskInvariants(cleanState({ planApproval: approval }))).toEqual([]);
  expect(checkTaskInvariants(cleanState({ planApproval: approval, phase: "plan" })).map(item => item.code)).toContain("I7/plan-approval-phase-mismatch");
  expect(checkTaskInvariants(cleanState({ planApproval: approval, cognition: cognition({ revision: 1, amendments: [] }) })).map(item => item.code)).toContain("I7/plan-approval-ahead-of-cognition");
  expect(checkTaskInvariants(cleanState({ planApproval: approval, contractVersion: 2, contractHistory: [{ version: 1, objective: "first", revisedAt: now }] })).map(item => item.code)).toContain("I7/plan-approval-contract-mismatch");
});

test("steps that claim work without a live attempt, or finish before their dependencies, are reported", () => {
  const running = { id: "s1", objective: "fix", mode: "implement" as const, dependsOn: [], skillIds: [], status: "running" as const, statusReason: "dispatched" };
  expect(checkTaskInvariants(cleanState({ cognition: cognition({ steps: [running] }) })).map(item => item.code)).toContain("S/step-running-without-instance");
  const withInstance = cleanState({
    cognition: cognition({
      steps: [running],
      instances: [{ id: "attempt-1", orderId: "s1", mode: "implement", skills: [], contractVersion: 1, cognitionRevision: 2, baseRevision: revision, status: "running", startedAt: now }],
    }),
  });
  expect(checkTaskInvariants(withInstance)).toEqual([]);

  const done = { id: "s2", objective: "verify", mode: "review" as const, dependsOn: ["s1"], skillIds: [], status: "complete" as const, statusReason: "verified" };
  const unfinishedDependency = cleanState({ cognition: cognition({ steps: [running, done] }) });
  expect(checkTaskInvariants(unfinishedDependency).map(item => item.code)).toContain("S/step-complete-with-unmet-dependency");
});

test("terminal states must carry their reason", () => {
  expect(checkTaskInvariants(cleanState({ status: "stopped" })).map(item => item.code)).toEqual(["S/stopped-without-reason"]);
  expect(checkTaskInvariants(cleanState({ status: "stopped", lastFailure: "User cancelled" }))).toEqual([]);
  expect(checkTaskInvariants(cleanState({ status: "stopped", goal: { enabled: false, stopReason: "no-progress" } }))).toEqual([]);
  expect(checkTaskInvariants({ ...acceptedState(), lastFailure: "Browser verification failed" }).map(item => item.code)).toEqual(["S/complete-with-failure"]);
});
