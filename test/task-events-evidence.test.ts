import { describe, expect, test } from "bun:test";
import type { Evidence, LocalPreview, RunRecord, TaskState } from "../src/runtime/task-ledger";
import { evidenceReducers } from "../src/runtime/task-events/apply/evidence";
import { InvariantError } from "../src/runtime/task-events/errors";
import type { TaskEventOf, TaskEventType } from "../src/runtime/task-events/types";

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
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function apply<Type extends TaskEventType>(state: TaskState, type: Type, payload: TaskEventOf<Type>["payload"]): void {
  const reducer = evidenceReducers[type] as ((state: TaskState, event: TaskEventOf<Type>) => void) | undefined;
  if (!reducer) throw new Error(`evidenceReducers has no reducer for ${type}`);
  reducer(state, { seq: 1, at: "2026-09-28T01:00:00.000Z", actor: "runtime", type, payload });
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

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev-1",
    criterionId: "c1",
    kind: "test",
    revision: "rev-1",
    contractVersion: 1,
    passed: true,
    source: "bun test ./test/app.test.ts",
    recordedAt: "2026-09-28T01:00:00.000Z",
    ...overrides,
  };
}

function preview(overrides: Partial<LocalPreview> = {}): LocalPreview {
  return {
    id: "prev-1",
    revision: "rev-1",
    path: "/srv/project/dist",
    url: "http://127.0.0.1:4173/",
    recordedAt: "2026-09-28T01:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    model: "provider/model",
    contractVersion: 1,
    toolCalls: 4,
    maxToolCalls: 100,
    wallTimeMs: 1200,
    elapsedMs: 1000,
    outcome: "returned",
    recordedAt: "2026-09-28T01:00:00.000Z",
    ...overrides,
  };
}

const criteria = [{ id: "c1", description: "Tests pass", kind: "test" as const }];

describe("evidence/recorded", () => {
  test("pushes the payload record verbatim when every guard passes", () => {
    const state = baseState({ criteria });
    const record = evidence();
    apply(state, "evidence/recorded", { evidence: record });
    expect(state.evidence).toEqual([record]);
    expect(state.evidence[0]).toBe(record);
  });

  test("rejects a task that is not active", () => {
    const state = baseState({ criteria, status: "stopped" });
    expectInvariant(() => apply(state, "evidence/recorded", { evidence: evidence() }), "apply/not-active", "Task is stopped");
    expect(state.evidence).toEqual([]);
  });

  test("rejects unknown criterion and kind mismatch, before the revision check", () => {
    const state = baseState({ criteria });
    expectInvariant(
      () => apply(state, "evidence/recorded", { evidence: evidence({ criterionId: "nope", revision: "stale" }) }),
      "apply/evidence-criterion-mismatch",
      "Evidence does not match a criterion",
    );
    expectInvariant(
      () => apply(state, "evidence/recorded", { evidence: evidence({ kind: "build" }) }),
      "apply/evidence-criterion-mismatch",
      "Evidence does not match a criterion",
    );
    expect(state.evidence).toEqual([]);
  });

  test("rejects a stale evidence revision", () => {
    const state = baseState({ criteria });
    expectInvariant(
      () => apply(state, "evidence/recorded", { evidence: evidence({ revision: "rev-0" }) }),
      "apply/evidence-revision-stale",
      "Evidence revision is stale",
    );
  });

  test("browser evidence must match the current preview", () => {
    const browserCriteria = [{ id: "c1", description: "Preview renders", kind: "browser" as const }];
    const noPreview = baseState({ criteria: browserCriteria });
    expectInvariant(
      () => apply(noPreview, "evidence/recorded", { evidence: evidence({ kind: "browser", previewId: "prev-1" }) }),
      "apply/evidence-preview-mismatch",
      "Browser evidence must match the current preview",
    );
    const wrongId = baseState({ criteria: browserCriteria, preview: preview({ id: "prev-2" }) });
    expectInvariant(
      () => apply(wrongId, "evidence/recorded", { evidence: evidence({ kind: "browser", previewId: "prev-1" }) }),
      "apply/evidence-preview-mismatch",
      "Browser evidence must match the current preview",
    );
    const matching = baseState({ criteria: browserCriteria, preview: preview() });
    apply(matching, "evidence/recorded", { evidence: evidence({ kind: "browser", previewId: "prev-1" }) });
    expect(matching.evidence).toHaveLength(1);
  });

  test("rejects a blank source", () => {
    const state = baseState({ criteria });
    expectInvariant(
      () => apply(state, "evidence/recorded", { evidence: evidence({ source: "   " }) }),
      "apply/evidence-source-blank",
      "Evidence source is required",
    );
  });

  test("source and artifact evidence need a 64-hex content hash", () => {
    for (const kind of ["source", "artifact"] as const) {
      const kindCriteria = [{ id: "c1", description: "d", kind }];
      const missing = baseState({ criteria: kindCriteria });
      expectInvariant(
        () => apply(missing, "evidence/recorded", { evidence: evidence({ kind }) }),
        "apply/evidence-hash-missing",
        "Versioned source or artifact evidence needs a SHA-256 hash",
      );
      const short = baseState({ criteria: kindCriteria });
      expectInvariant(
        () => apply(short, "evidence/recorded", { evidence: evidence({ kind, contentHash: "abc123" }) }),
        "apply/evidence-hash-missing",
        "Versioned source or artifact evidence needs a SHA-256 hash",
      );
      const ok = baseState({ criteria: kindCriteria });
      apply(ok, "evidence/recorded", { evidence: evidence({ kind, contentHash: "a".repeat(64) }) });
      expect(ok.evidence).toHaveLength(1);
    }
    // A test-kind record without a hash is fine.
    const noHash = baseState({ criteria });
    apply(noHash, "evidence/recorded", { evidence: evidence() });
    expect(noHash.evidence).toHaveLength(1);
  });

  test("appends in order across multiple events", () => {
    const state = baseState({ criteria });
    apply(state, "evidence/recorded", { evidence: evidence({ id: "ev-1" }) });
    apply(state, "evidence/recorded", { evidence: evidence({ id: "ev-2" }) });
    expect(state.evidence.map(item => item.id)).toEqual(["ev-1", "ev-2"]);
  });
});

describe("run/ended", () => {
  test("initializes runs and appends each record", () => {
    const state = baseState();
    const first = run({ toolCalls: 1 });
    const second = run({ toolCalls: 2 });
    apply(state, "run/ended", { run: first });
    apply(state, "run/ended", { run: second });
    expect(state.runs).toEqual([first, second]);
    expect(state.runs?.[0]).toBe(first);
  });

  test("keeps appending to pre-existing runs", () => {
    const existing = run({ toolCalls: 9 });
    const added = run({ toolCalls: 3 });
    const state = baseState({ runs: [existing] });
    apply(state, "run/ended", { run: added });
    expect(state.runs).toEqual([existing, added]);
  });
});

describe("preview/published", () => {
  test("replaces state.preview with the payload record", () => {
    const state = baseState({ preview: preview({ id: "old" }) });
    const record = preview();
    apply(state, "preview/published", { preview: record });
    expect(state.preview).toBe(record);
  });

  test("rejects a task that is not active", () => {
    const state = baseState({ status: "complete" });
    expectInvariant(() => apply(state, "preview/published", { preview: preview() }), "apply/not-active", "Task is complete");
    expect(state.preview).toBeNull();
  });

  test("rejects a stale preview revision", () => {
    const state = baseState();
    expectInvariant(
      () => apply(state, "preview/published", { preview: preview({ revision: "rev-0" }) }),
      "apply/preview-revision-stale",
      "Preview revision is stale",
    );
  });

  test("rejects a relative path or a non-loopback URL", () => {
    const relative = baseState();
    expectInvariant(
      () => apply(relative, "preview/published", { preview: preview({ path: "dist/index.html" }) }),
      "apply/preview-not-local-loopback",
      "Preview must use an absolute local path and loopback URL",
    );
    const remote = baseState();
    expectInvariant(
      () => apply(remote, "preview/published", { preview: preview({ url: "https://example.com/" }) }),
      "apply/preview-not-local-loopback",
      "Preview must use an absolute local path and loopback URL",
    );
    expect(remote.preview).toBeNull();
  });
});

describe("run/ended", () => {
  test("initializes runs and appends each record", () => {
    const state = baseState();
    const first = run({ toolCalls: 1 });
    const second = run({ toolCalls: 2 });
    apply(state, "run/ended", { run: first });
    apply(state, "run/ended", { run: second });
    expect(state.runs).toEqual([first, second]);
    expect(state.runs?.[0]).toBe(first);
  });

  test("keeps appending to pre-existing runs", () => {
    const existing = run({ toolCalls: 9 });
    const state = baseState({ runs: [existing] });
    apply(state, "run/ended", { run: run() });
    expect(state.runs).toEqual([existing, state.runs![1]]);
    expect(state.runs).toHaveLength(2);
  });
});

describe("development/enabled", () => {
  test("enables the workflow from scratch with fresh key order", () => {
    const state = baseState();
    apply(state, "development/enabled", {});
    expect(state.development).toEqual({ enabled: true, repairAttempts: 0 });
    expect(JSON.stringify(state.development)).toBe('{"enabled":true,"repairAttempts":0}');
  });

  test("is a silent no-op when already enabled, preserving repair attempts", () => {
    const state = baseState({ development: { enabled: true, repairAttempts: 1 } });
    apply(state, "development/enabled", {});
    expect(state.development).toEqual({ enabled: true, repairAttempts: 1 });
  });
});

describe("review/recorded", () => {
  const review = {
    verdict: "pass" as const,
    findings: ["Looks good"],
    revision: "rev-1",
    contractVersion: 1,
    instanceId: "inst-1",
    recordedAt: "2026-09-28T01:00:00.000Z",
  };

  test("assigns the payload review when the workflow is enabled", () => {
    const state = baseState({ development: { enabled: true, repairAttempts: 0 } });
    apply(state, "review/recorded", { review });
    expect(state.development?.review).toBe(review);
  });

  test("rejects a task that is not active", () => {
    const state = baseState({ status: "needs-input", development: { enabled: true, repairAttempts: 0 } });
    expectInvariant(() => apply(state, "review/recorded", { review }), "apply/not-active", "Task is needs-input");
  });

  test("rejects when the development workflow is off or missing", () => {
    const missing = baseState();
    expectInvariant(() => apply(missing, "review/recorded", { review }), "apply/review-state-invalid", "开发审查状态无效");
    expect(missing.development).toBeUndefined();
  });

  test("rejects a null revision", () => {
    const state = baseState({ revision: null, development: { enabled: true, repairAttempts: 0 } });
    expectInvariant(() => apply(state, "review/recorded", { review }), "apply/review-state-invalid", "开发审查状态无效");
    expect(state.development?.review).toBeUndefined();
  });

  test("rejects a blank instance id", () => {
    const state = baseState({ development: { enabled: true, repairAttempts: 0 } });
    expectInvariant(
      () => apply(state, "review/recorded", { review: { ...review, instanceId: "" } }),
      "apply/review-state-invalid",
      "开发审查状态无效",
    );
    expect(state.development?.review).toBeUndefined();
  });

  test("replaces a previous review", () => {
    const state = baseState({
      development: { enabled: true, repairAttempts: 0, review: { ...review, verdict: "inconclusive" } },
    });
    apply(state, "review/recorded", { review });
    expect(state.development?.review?.verdict).toBe("pass");
  });
});

describe("repair-attempt/recorded", () => {
  test("increments up to the limit of two attempts", () => {
    const state = baseState({ development: { enabled: true, repairAttempts: 0 } });
    apply(state, "repair-attempt/recorded", {});
    expect(state.development?.repairAttempts).toBe(1);
    apply(state, "repair-attempt/recorded", {});
    expect(state.development?.repairAttempts).toBe(2);
  });

  test("rejects the third attempt and leaves the counter untouched", () => {
    const state = baseState({ development: { enabled: true, repairAttempts: 2 } });
    expectInvariant(() => apply(state, "repair-attempt/recorded", {}), "apply/repair-attempts-exhausted", "自动修复次数已用尽");
    expect(state.development?.repairAttempts).toBe(2);
  });

  test("rejects when the workflow is not enabled", () => {
    const state = baseState();
    expectInvariant(() => apply(state, "repair-attempt/recorded", {}), "apply/repair-attempts-exhausted", "自动修复次数已用尽");
    expect(state.development).toBeUndefined();
  });
});
