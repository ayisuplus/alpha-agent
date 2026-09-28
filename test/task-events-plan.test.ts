import { describe, expect, test } from "bun:test";
import type { CognitionState, CognitionStep, TaskState } from "../src/runtime/task-ledger";
import { planReducers } from "../src/runtime/task-events/apply/plan";
import { InvariantError } from "../src/runtime/task-events/errors";
import type { TaskEventOf, TaskEventType } from "../src/runtime/task-events/types";

const AT = "2026-09-28T01:00:00.000Z";

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
  const reducer = planReducers[type] as ((state: TaskState, event: TaskEventOf<Type>) => void) | undefined;
  if (!reducer) throw new Error(`planReducers has no reducer for ${type}`);
  reducer(state, { seq: 1, at: AT, actor: "runtime", type, payload });
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

function step(id: string, overrides: Partial<CognitionStep> = {}): CognitionStep {
  return { id, objective: `Deliver ${id}`, mode: "implement", dependsOn: [], skillIds: [], status: "planned", ...overrides };
}

function cognition(overrides: Partial<CognitionState> = {}): CognitionState {
  return { revision: 1, recipeVersion: 1, summary: "Plan summary", candidates: [], steps: [], gaps: [], amendments: [], ...overrides };
}

function reviseInput(overrides: Partial<{ summary: string; candidates: string[]; steps: CognitionStep[]; reason: string; scope: string[]; constraints: string[]; openQuestions: string[] }> = {}) {
  return { summary: "Revised summary", candidates: ["expert-a"], steps: [step("build-api")], reason: "Split the work", ...overrides };
}

describe("plan/submitted", () => {
  test("requires the plan phase with nonempty steps", () => {
    const wrongPhase = baseState({ phase: "execute", cognition: cognition({ steps: [step("a")], basedOnRevision: "rev-1" }) });
    expectInvariant(() => apply(wrongPhase, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
    expect(wrongPhase.phase).toBe("execute");
    // The phase/steps gate wins over the revision gate.
    const staleWrongPhase = baseState({ phase: "execute", cognition: cognition({ steps: [], basedOnRevision: "stale" }) });
    expectInvariant(() => apply(staleWrongPhase, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
    const emptyPlan = baseState({ phase: "plan", cognition: cognition({ steps: [] }) });
    expectInvariant(() => apply(emptyPlan, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
    const noCognition = baseState({ phase: "plan" });
    expectInvariant(() => apply(noCognition, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
  });

  test("requires a plan based on the current source revision", () => {
    const state = baseState({ phase: "plan", cognition: cognition({ steps: [step("a")], basedOnRevision: "rev-0" }) });
    expectInvariant(
      () => apply(state, "plan/submitted", {}),
      "apply/plan-source-moved",
      "Project changed after planning; review the current source and revise the plan",
    );
    expect(state.phase).toBe("plan");
  });

  test("flips to plan-review when the plan matches the source", () => {
    const state = baseState({ phase: "plan", cognition: cognition({ steps: [step("a")], basedOnRevision: "rev-1" }) });
    apply(state, "plan/submitted", {});
    expect(state.phase).toBe("plan-review");
  });
});

describe("plan/approved", () => {
  const approval = { contractVersion: 1, cognitionRevision: 2, sourceRevision: "rev-1", approvedAt: AT };
  const planned = (overrides: Partial<TaskState> = {}) =>
    baseState({ phase: "plan-review", cognition: cognition({ revision: 2 }), ...overrides });

  test("requires a plan awaiting review on an active task", () => {
    expectInvariant(
      () => apply(planned({ phase: "plan" }), "plan/approved", { approval }),
      "apply/no-plan-awaiting-review",
      "Task has no plan awaiting review",
    );
    const stopped = planned({ status: "stopped" });
    expectInvariant(
      () => apply(stopped, "plan/approved", { approval }),
      "apply/no-plan-awaiting-review",
      "Task has no plan awaiting review",
    );
    expect(stopped.planApproval).toBeUndefined();
  });

  test("rejects stale contract, cognition or source revisions", () => {
    const cases: Array<[TaskState, typeof approval]> = [
      [planned({ contractVersion: 2 }), { ...approval, contractVersion: 1 }],
      [planned(), { ...approval, cognitionRevision: 1 }],
      [planned(), { ...approval, sourceRevision: "rev-0" }],
    ];
    for (const [state, stale] of cases) {
      expectInvariant(
        () => apply(state, "plan/approved", { approval: stale }),
        "apply/plan-approval-stale",
        "Plan or project changed; review the current version before executing",
      );
      expect(state.phase).toBe("plan-review");
      expect(state.planApproval).toBeUndefined();
    }
  });

  test("records the approval, enters execute and resets the goal", () => {
    const state = planned({ goal: { enabled: true, noProgressRuns: 3, stopReason: "no-progress" } });
    apply(state, "plan/approved", { approval });
    expect(state.phase).toBe("execute");
    expect(Object.keys(state.planApproval!)).toEqual(["contractVersion", "cognitionRevision", "sourceRevision", "approvedAt"]);
    expect(state.planApproval).toEqual(approval);
    expect(state.goal!.noProgressRuns).toBe(0);
    expect(state.goal!.stopReason).toBeUndefined();
  });

  test("leaves a missing goal alone", () => {
    const state = planned();
    apply(state, "plan/approved", { approval });
    expect(state.goal).toBeUndefined();
    expect(state.phase).toBe("execute");
  });
});

describe("plan/revised", () => {
  test("bumps the revision, appends the amendment and preserves step statuses", () => {
    const state = baseState({
      phase: "execute",
      cognition: cognition({
        revision: 3,
        summary: "Old summary",
        basedOnRevision: "rev-0",
        scope: ["old scope"],
        steps: [
          step("build-api", { status: "running", statusReason: "工单 wo-1 运行中" }),
          step("write-tests", { status: "complete", statusReason: "done" }),
          step("docs", { status: "planned", statusReason: "later" }),
        ],
        amendments: [{ revision: 3, reason: "earlier", affectedSteps: ["build-api"], recordedAt: "2026-09-27T00:00:00.000Z" }],
      }),
    });
    apply(state, "plan/revised", {
      input: reviseInput({
        steps: [
          step("build-api", { status: "planned", statusReason: "stale" }),
          step("write-tests"),
          step("docs"),
          step("ship-it", { dependsOn: ["build-api"] }),
        ],
        scope: [" new scope ", "new scope", "", "old scope"],
      }),
      recordedAt: AT,
    });
    const next = state.cognition!;
    expect(next.revision).toBe(4);
    expect(next.basedOnRevision).toBe("rev-1");
    expect(next.summary).toBe("Revised summary");
    expect(next.scope).toEqual(["new scope", "old scope"]);
    expect(next.candidates).toEqual(["expert-a"]);
    // running/complete statuses and reasons survive even when the input resets them
    expect(next.steps.map(item => [item.id, item.status, item.statusReason])).toEqual([
      ["build-api", "running", "工单 wo-1 运行中"],
      ["write-tests", "complete", "done"],
      ["docs", "planned", "later"],
      ["ship-it", "planned", undefined],
    ]);
    expect(next.amendments).toEqual([
      { revision: 3, reason: "earlier", affectedSteps: ["build-api"], recordedAt: "2026-09-27T00:00:00.000Z" },
      { revision: 4, reason: "Split the work", affectedSteps: ["build-api", "write-tests", "docs", "ship-it"], recordedAt: AT },
    ]);
    // no planApproval: no phase flip
    expect(state.phase).toBe("execute");
    expect(state.planApproval).toBeUndefined();
  });

  test("a material change drops the approval and returns to plan-review", () => {
    const approval = { contractVersion: 1, cognitionRevision: 1, sourceRevision: "rev-1", approvedAt: AT };
    const state = baseState({ phase: "execute", planApproval: approval, cognition: cognition({ steps: [step("build-api")] }) });
    apply(state, "plan/revised", {
      input: reviseInput({ steps: [step("build-api"), step("extra-step")] }),
      recordedAt: AT,
    });
    expect(state.phase).toBe("plan-review");
    expect("planApproval" in state).toBe(false);
  });

  test("an immaterial revision keeps the approval and phase", () => {
    const approval = { contractVersion: 1, cognitionRevision: 1, sourceRevision: "rev-1", approvedAt: AT };
    const state = baseState({
      phase: "execute",
      planApproval: approval,
      cognition: cognition({ scope: ["scope-a"], steps: [step("build-api"), step("docs")] }),
    });
    // Identical step definitions, unchanged scope/constraints (undefined falls back), only the summary differs.
    apply(state, "plan/revised", {
      input: reviseInput({ steps: [step("build-api"), step("docs")] }),
      recordedAt: AT,
    });
    expect(state.phase).toBe("execute");
    expect(state.planApproval).toEqual(approval);
    expect(state.cognition!.scope).toEqual(["scope-a"]);
    expect(state.cognition!.revision).toBe(2);
  });

  test("redefining a pending step is a material change", () => {
    const approval = { contractVersion: 1, cognitionRevision: 1, sourceRevision: "rev-1", approvedAt: AT };
    const state = baseState({
      phase: "execute",
      planApproval: approval,
      cognition: cognition({ steps: [step("build-api"), step("docs", { mode: "investigate" })] }),
    });
    apply(state, "plan/revised", {
      input: reviseInput({ steps: [step("build-api"), step("docs", { mode: "implement" })] }),
      recordedAt: AT,
    });
    expect(state.phase).toBe("plan-review");
    expect("planApproval" in state).toBe(false);
  });

  test("rejects invalid content", () => {
    const blankSummary = baseState({ cognition: cognition() });
    expectInvariant(
      () => apply(blankSummary, "plan/revised", { input: reviseInput({ summary: "   " }), recordedAt: AT }),
      "apply/cognition-content-invalid",
      "认知修订内容无效",
    );
    const blankReason = baseState({ cognition: cognition() });
    expectInvariant(
      () => apply(blankReason, "plan/revised", { input: reviseInput({ reason: "" }), recordedAt: AT }),
      "apply/cognition-content-invalid",
      "认知修订内容无效",
    );
    const tooMany = baseState({ cognition: cognition() });
    expectInvariant(
      () => apply(tooMany, "plan/revised", {
        input: reviseInput({ steps: Array.from({ length: 21 }, (_, i) => step(`s${i}`)) }),
        recordedAt: AT,
      }),
      "apply/cognition-content-invalid",
      "认知修订内容无效",
    );
  });

  test("rejects malformed steps", () => {
    const cases: CognitionStep[][] = [
      [step("dup"), step("dup", { objective: "other" })],
      [step("Bad-Case")],
      [step("coordinator")],
      [step("final-review")],
      [step("review-repair")],
      [step("blank", { objective: "  " })],
      [step("orphan", { dependsOn: ["ghost"] })],
      [step("self", { dependsOn: ["self"] })],
    ];
    for (const steps of cases) {
      expectInvariant(
        () => apply(baseState({ cognition: cognition() }), "plan/revised", { input: reviseInput({ steps }), recordedAt: AT }),
        "apply/cognition-steps-invalid",
        "认知步骤无效",
      );
    }
  });

  test("detects dependency cycles", () => {
    expectInvariant(
      () => apply(baseState({ cognition: cognition() }), "plan/revised", {
        input: reviseInput({ steps: [step("a", { dependsOn: ["b"] }), step("b", { dependsOn: ["a"] })] }),
        recordedAt: AT,
      }),
      "apply/cognition-cycle",
      "认知步骤存在循环依赖",
    );
  });

  test("keeps the designated expert in candidates and steps", () => {
    const dropped = baseState({ designatedExpertId: "expert-9", cognition: cognition() });
    expectInvariant(
      () => apply(dropped, "plan/revised", { input: reviseInput({ candidates: ["expert-a"] }), recordedAt: AT }),
      "apply/designated-expert-dropped",
      "用户指定专家必须保留在计划中：expert-9",
    );
    const noStep = baseState({ designatedExpertId: "expert-9", cognition: cognition() });
    expectInvariant(
      () => apply(noStep, "plan/revised", {
        input: reviseInput({ candidates: ["expert-9"], steps: [step("build-api", { expertId: "expert-a" })] }),
        recordedAt: AT,
      }),
      "apply/designated-expert-dropped",
      "用户指定专家必须保留在计划中：expert-9",
    );
    // An empty step list only needs the candidate entry.
    const ok = baseState({ designatedExpertId: "expert-9", cognition: cognition() });
    apply(ok, "plan/revised", { input: reviseInput({ candidates: ["expert-9"], steps: [] }), recordedAt: AT });
    expect(ok.cognition!.candidates).toEqual(["expert-9"]);
  });

  test("refuses to rewrite or drop running and completed steps", () => {
    const rewritten = baseState({ cognition: cognition({ steps: [step("build-api", { status: "running" })] }) });
    expectInvariant(
      () => apply(rewritten, "plan/revised", {
        input: reviseInput({ steps: [step("build-api", { objective: "Something else" })] }),
        recordedAt: AT,
      }),
      "apply/dispatched-step-rewritten",
      "已派发或完成的认知步骤不可改写：build-api",
    );
    const dropped = baseState({ cognition: cognition({ steps: [step("write-tests", { status: "complete" })] }) });
    expectInvariant(
      () => apply(dropped, "plan/revised", { input: reviseInput({ steps: [step("build-api")] }), recordedAt: AT }),
      "apply/dispatched-step-rewritten",
      "已派发或完成的认知步骤不可改写：write-tests",
    );
  });

  test("a first revision starts from revision 1 and cleans the lists", () => {
    const state = baseState({ revision: "rev-7" });
    apply(state, "plan/revised", {
      input: reviseInput({
        candidates: ["a", "a", "b"],
        constraints: [" dup ", "dup", ""],
        openQuestions: ["q1"],
        steps: [step("build-api")],
      }),
      recordedAt: AT,
    });
    const next = state.cognition!;
    expect(next.revision).toBe(1);
    expect(next.summary).toBe("Revised summary");
    expect(next.basedOnRevision).toBe("rev-7");
    expect(next.candidates).toEqual(["a", "b"]);
    expect(next.constraints).toEqual(["dup"]);
    expect(next.openQuestions).toEqual(["q1"]);
    expect(next.scope).toBeUndefined();
    expect(next.recipeVersion).toBe(1);
  });
});

describe("step/changed", () => {
  test("requires an active task", () => {
    const state = baseState({ status: "stopped", cognition: cognition({ steps: [step("a")] }) });
    expectInvariant(() => apply(state, "step/changed", { id: "a", status: "running", reason: "go" }), "apply/task-not-active", "Task is stopped");
  });

  test("requires an existing step, a usable status and a non-blank reason", () => {
    const payloads = [
      { id: "ghost", status: "running" as const, reason: "go" },
      { id: "a", status: "planned" as const, reason: "go" },
      { id: "a", status: "running" as const, reason: "   " },
    ];
    for (const payload of payloads) {
      const state = baseState({ phase: "execute", cognition: cognition({ steps: [step("a")] }) });
      expectInvariant(() => apply(state, "step/changed", payload), "apply/step-required", "Step and reason are required");
    }
  });

  test("finished steps cannot be rewritten", () => {
    for (const status of ["complete", "cancelled"] as const) {
      const state = baseState({ phase: "execute", cognition: cognition({ steps: [step("a", { status })] }) });
      expectInvariant(() => apply(state, "step/changed", { id: "a", status: "blocked", reason: "stuck" }), "apply/step-finished", "Finished step cannot be rewritten");
    }
  });

  test("delegated steps belong to the work order, checked before the phase gates", () => {
    const instance = {
      id: "inst-1", orderId: "a", mode: "implement" as const, skills: [], contractVersion: 1, cognitionRevision: 1,
      baseRevision: null, status: "running" as const, startedAt: AT,
    };
    const state = baseState({ phase: "plan-review", cognition: cognition({ steps: [step("a", { status: "running" })], instances: [instance] }) });
    expectInvariant(
      () => apply(state, "step/changed", { id: "a", status: "complete", reason: "done" }),
      "apply/step-delegated",
      "Delegated step status is owned by the work order result",
    );
  });

  test("the plan phase only finishes investigation steps", () => {
    const implement = baseState({ phase: "plan", cognition: cognition({ steps: [step("a", { mode: "implement" })] }) });
    expectInvariant(
      () => apply(implement, "step/changed", { id: "a", status: "complete", reason: "done" }),
      "apply/step-plan-mode",
      "Planning can only finish investigation steps",
    );
    const investigate = baseState({ phase: "plan", cognition: cognition({ steps: [step("a", { mode: "investigate" })] }) });
    apply(investigate, "step/changed", { id: "a", status: "complete", reason: " surveyed " });
    expect(investigate.cognition!.steps[0]).toMatchObject({ status: "complete", statusReason: "surveyed" });
  });

  test("plan-review blocks every step change", () => {
    const state = baseState({ phase: "plan-review", cognition: cognition({ steps: [step("a", { mode: "investigate" })] }) });
    expectInvariant(() => apply(state, "step/changed", { id: "a", status: "running", reason: "go" }), "apply/plan-awaiting-review", "Plan is awaiting review");
  });

  test("completing requires complete dependencies", () => {
    const state = baseState({
      phase: "execute",
      cognition: cognition({ steps: [step("dep", { status: "running" }), step("a", { dependsOn: ["dep"] })] }),
    });
    expectInvariant(
      () => apply(state, "step/changed", { id: "a", status: "complete", reason: "done" }),
      "apply/step-deps-incomplete",
      "Step dependencies are not complete",
    );
    state.cognition!.steps[0].status = "complete";
    apply(state, "step/changed", { id: "a", status: "complete", reason: "done" });
    expect(state.cognition!.steps[1].status).toBe("complete");
  });

  test("sets the trimmed reason for non-complete statuses without dependency checks", () => {
    const state = baseState({ phase: "execute", cognition: cognition({ steps: [step("a", { status: "running", dependsOn: ["dep"] })] }) });
    apply(state, "step/changed", { id: "a", status: "blocked", reason: " waiting on review " });
    expect(state.cognition!.steps[0]).toMatchObject({ status: "blocked", statusReason: "waiting on review" });
  });
});

describe("candidates/set", () => {
  test("silently ignores every non-initial situation", () => {
    const noCognition = baseState();
    apply(noCognition, "candidates/set", { candidates: ["a"] });
    expect(noCognition.cognition).toBeUndefined();

    const revised = baseState({ cognition: cognition({ revision: 2 }) });
    apply(revised, "candidates/set", { candidates: ["a"] });
    expect(revised.cognition!.candidates).toEqual([]);

    const populated = baseState({ cognition: cognition({ candidates: ["existing"] }) });
    apply(populated, "candidates/set", { candidates: ["a"] });
    expect(populated.cognition!.candidates).toEqual(["existing"]);

    const nothing = baseState({ cognition: cognition() });
    apply(nothing, "candidates/set", { candidates: [] });
    expect(nothing.cognition!.candidates).toEqual([]);
  });

  test("puts the designated expert first, de-duplicates and caps at three", () => {
    const state = baseState({ designatedExpertId: "expert-9", cognition: cognition() });
    apply(state, "candidates/set", { candidates: ["a", "b", "c", "a", "expert-9"] });
    expect(state.cognition!.candidates).toEqual(["expert-9", "a", "b"]);
  });

  test("an empty list with a designated expert still seeds the candidate", () => {
    const state = baseState({ designatedExpertId: "expert-9", cognition: cognition() });
    apply(state, "candidates/set", { candidates: [] });
    expect(state.cognition!.candidates).toEqual(["expert-9"]);
  });
});

describe("capability-gap events", () => {
  test("recording requires an active task and a description", () => {
    expectInvariant(
      () => apply(baseState({ status: "complete" }), "capability-gap/recorded", { kind: "tool", description: "need kubectl", recordedAt: AT }),
      "apply/task-not-active",
      "Task is complete",
    );
    expectInvariant(
      () => apply(baseState(), "capability-gap/recorded", { kind: "tool", description: "  ", recordedAt: AT }),
      "apply/gap-description-blank",
      "能力缺口说明不能为空",
    );
  });

  test("recording without cognition creates the default and bumps the revision", () => {
    const state = baseState();
    apply(state, "capability-gap/recorded", { kind: "method", description: " need a deploy path ", recordedAt: AT });
    expect(Object.keys(state.cognition!)).toEqual(["revision", "recipeVersion", "summary", "candidates", "steps", "gaps", "amendments"]);
    expect(state.cognition).toMatchObject({ revision: 2, recipeVersion: 1, summary: "Ship the feature", candidates: [], steps: [], amendments: [] });
    expect(state.cognition!.gaps).toEqual([{ kind: "method", description: "need a deploy path", recordedAt: AT }]);
  });

  test("a duplicate kind+description is a silent no-op", () => {
    const state = baseState({ cognition: cognition({ revision: 5, gaps: [{ kind: "tool", description: "need kubectl", recordedAt: AT }] }) });
    apply(state, "capability-gap/recorded", { kind: "tool", description: " need kubectl ", recordedAt: "2026-09-28T02:00:00.000Z" });
    expect(state.cognition!.revision).toBe(5);
    expect(state.cognition!.gaps).toHaveLength(1);
    // Same description, other kind: recorded.
    apply(state, "capability-gap/recorded", { kind: "permission", description: "need kubectl", recordedAt: AT });
    expect(state.cognition!.revision).toBe(6);
    expect(state.cognition!.gaps).toHaveLength(2);
  });

  test("resolving requires a resolution and an open gap", () => {
    const gap = { kind: "method" as const, description: "need a deploy path", recordedAt: AT };
    expectInvariant(
      () => apply(baseState({ cognition: cognition({ gaps: [{ ...gap }] }) }), "capability-gap/resolved", { ...gap, resolution: "  ", resolvedAt: AT }),
      "apply/gap-resolution-blank",
      "能力缺口解决依据不能为空",
    );
    expectInvariant(
      () => apply(baseState({ cognition: cognition({ gaps: [] }) }), "capability-gap/resolved", { ...gap, resolution: "installed a skill", resolvedAt: AT }),
      "apply/gap-not-open",
      "待解决的能力缺口不存在",
    );
    const already = baseState({ cognition: cognition({ gaps: [{ ...gap, resolvedAt: AT, resolution: "done" }] }) });
    expectInvariant(
      () => apply(already, "capability-gap/resolved", { ...gap, resolution: "again", resolvedAt: AT }),
      "apply/gap-not-open",
      "待解决的能力缺口不存在",
    );
    const wrongKind = baseState({ cognition: cognition({ gaps: [{ ...gap }] }) });
    expectInvariant(
      () => apply(wrongKind, "capability-gap/resolved", { ...gap, kind: "tool", resolution: "x", resolvedAt: AT }),
      "apply/gap-not-open",
      "待解决的能力缺口不存在",
    );
  });

  test("resolving stamps the payload time, trims the resolution and clears the blocker", () => {
    const state = baseState({
      cognition: cognition({
        revision: 4,
        gaps: [{ kind: "method", description: "need a deploy path", recordedAt: AT, blockingReason: "已安装 x，但需要外部服务 docker；仍需调整执行方式或能力" }],
      }),
    });
    apply(state, "capability-gap/resolved", { kind: "method", description: "need a deploy path", resolution: " installed a skill ", resolvedAt: "2026-09-28T03:00:00.000Z" });
    expect(state.cognition!.revision).toBe(5);
    expect(state.cognition!.gaps[0]).toEqual({ kind: "method", description: "need a deploy path", recordedAt: AT, resolvedAt: "2026-09-28T03:00:00.000Z", resolution: "installed a skill" });
    expect("blockingReason" in state.cognition!.gaps[0]).toBe(false);
  });
});

describe("skill-search/recorded", () => {
  const proposal = {
    id: "prop-1", key: "method:need kubectl", name: "kubectl-skill", description: "Deploy with kubectl",
    source: "registry", revision: "1.0.0", path: "skills/kubectl", installs: 12, status: "pending" as const, recordedAt: AT,
  };

  test("requires an active task", () => {
    const state = baseState({ status: "needs-input", cognition: cognition() });
    expectInvariant(
      () => apply(state, "skill-search/recorded", { key: "k", gapDescription: "g", query: "q", resultCount: 1, proposals: [proposal], recordedAt: AT }),
      "apply/task-not-active",
      "Task is needs-input",
    );
  });

  test("records the search and proposals once, skipping repeats", () => {
    const state = baseState({ cognition: cognition({ revision: 2 }) });
    const payload = { key: "method:need kubectl", gapDescription: "need kubectl", query: "kubectl deploy", error: "timeout", resultCount: 1, proposals: [proposal], recordedAt: AT };
    apply(state, "skill-search/recorded", payload);
    expect(state.cognition!.revision).toBe(3);
    expect(Object.keys(state.cognition!.skillSearches![0])).toEqual(["key", "gapDescription", "query", "resultCount", "error", "recordedAt"]);
    expect(state.cognition!.skillSearches).toEqual([{ key: "method:need kubectl", gapDescription: "need kubectl", query: "kubectl deploy", resultCount: 1, error: "timeout", recordedAt: AT }]);
    expect(state.cognition!.skillProposals).toEqual([proposal]);

    // Same key again: silent no-op, nothing appended, revision untouched.
    apply(state, "skill-search/recorded", { ...payload, resultCount: 9, proposals: [{ ...proposal, id: "prop-2" }] });
    expect(state.cognition!.revision).toBe(3);
    expect(state.cognition!.skillSearches).toHaveLength(1);
    expect(state.cognition!.skillProposals).toHaveLength(1);
  });

  test("omits the error key when the search succeeded", () => {
    const state = baseState({ cognition: cognition() });
    apply(state, "skill-search/recorded", { key: "k", gapDescription: "g", query: "q", resultCount: 0, proposals: [], recordedAt: AT });
    expect(Object.keys(state.cognition!.skillSearches![0])).toEqual(["key", "gapDescription", "query", "resultCount", "recordedAt"]);
  });
});

describe("skill-proposal/decided", () => {
  function proposalState(requirements?: { tools: string[]; services: string[]; conflicts: string[] }, gap?: CognitionState["gaps"][number]): TaskState {
    return baseState({
      cognition: cognition({
        revision: 3,
        gaps: gap ? [gap] : [],
        skillSearches: [{ key: "method:need kubectl", gapDescription: "need kubectl", query: "q", resultCount: 1, recordedAt: AT }],
        skillProposals: [{
          id: "prop-1", key: "method:need kubectl", name: "kubectl-skill", description: "Deploy with kubectl",
          source: "registry", revision: "1.0.0", path: "skills/kubectl", installs: 12,
          ...(requirements ? { requirements } : {}),
          status: "pending" as const, recordedAt: AT,
        }],
      }),
    });
  }

  test("requires an active task", () => {
    const state = proposalState();
    state.status = "stopped";
    expectInvariant(
      () => apply(state, "skill-proposal/decided", { id: "prop-1", decision: "rejected", resolvedAt: AT }),
      "apply/task-not-active",
      "Task is stopped",
    );
  });

  test("unknown or already handled proposals are rejected", () => {
    expectInvariant(
      () => apply(proposalState(), "skill-proposal/decided", { id: "ghost", decision: "rejected", resolvedAt: AT }),
      "apply/skill-proposal-unhandled-missing",
      "Skill 提案不存在或已处理",
    );
    const handled = proposalState();
    handled.cognition!.skillProposals![0].status = "installed";
    expectInvariant(
      () => apply(handled, "skill-proposal/decided", { id: "prop-1", decision: "rejected", resolvedAt: AT }),
      "apply/skill-proposal-unhandled-missing",
      "Skill 提案不存在或已处理",
    );
  });

  test("installing requires the installed skill id", () => {
    expectInvariant(
      () => apply(proposalState(), "skill-proposal/decided", { id: "prop-1", decision: "installed", resolvedAt: AT }),
      "apply/installed-skill-id-missing",
      "安装后的 Skill ID 缺失",
    );
  });

  test("rejecting only flips the status and bumps the revision", () => {
    const state = proposalState();
    apply(state, "skill-proposal/decided", { id: "prop-1", decision: "rejected", resolvedAt: AT });
    expect(state.cognition!.skillProposals![0].status).toBe("rejected");
    expect(state.cognition!.skillProposals![0].installedSkillId).toBeUndefined();
    expect(state.cognition!.revision).toBe(4);
    expect(state.cognition!.taskSkillIds).toBeUndefined();
  });

  test("installing without blockers resolves the matching open method gap", () => {
    const gap = { kind: "method" as const, description: "need kubectl", recordedAt: AT, blockingReason: "stale blocker" };
    const state = proposalState({ tools: ["read", "grep"], services: [], conflicts: [] }, gap);
    apply(state, "skill-proposal/decided", { id: "prop-1", decision: "installed", installedSkillId: "skill-kubectl", resolvedAt: "2026-09-28T05:00:00.000Z" });
    expect(state.cognition!.skillProposals![0]).toMatchObject({ status: "installed", installedSkillId: "skill-kubectl" });
    expect(state.cognition!.taskSkillIds).toEqual(["skill-kubectl"]);
    expect(state.cognition!.revision).toBe(4);
    expect(state.cognition!.gaps[0]).toEqual({ kind: "method", description: "need kubectl", recordedAt: AT, resolvedAt: "2026-09-28T05:00:00.000Z", resolution: "Installed skill-kubectl" });
    expect("blockingReason" in state.cognition!.gaps[0]).toBe(false);
  });

  test("installing with blockers records the blocking reason instead", () => {
    const gap = { kind: "method" as const, description: "need kubectl", recordedAt: AT };
    const state = proposalState({ tools: ["kubectl"], services: ["docker"], conflicts: ["other-skill"] }, gap);
    state.cognition!.taskSkillIds = ["other-skill"];
    apply(state, "skill-proposal/decided", { id: "prop-1", decision: "installed", installedSkillId: "skill-kubectl", resolvedAt: AT });
    expect(state.cognition!.gaps[0].resolvedAt).toBeUndefined();
    expect(state.cognition!.gaps[0].blockingReason).toBe("已安装 skill-kubectl，但需要外部服务 docker、worker 缺少工具 kubectl、与 other-skill 冲突；仍需调整执行方式或能力");
    expect(state.cognition!.taskSkillIds).toEqual(["other-skill", "skill-kubectl"]);
  });

  test("installing without a matching gap only tracks the skill", () => {
    const state = proposalState(undefined, { kind: "tool" as const, description: "unrelated", recordedAt: AT });
    apply(state, "skill-proposal/decided", { id: "prop-1", decision: "installed", installedSkillId: "skill-kubectl", resolvedAt: AT });
    expect(state.cognition!.taskSkillIds).toEqual(["skill-kubectl"]);
    expect(state.cognition!.gaps[0].resolvedAt).toBeUndefined();
    expect(state.cognition!.gaps[0].blockingReason).toBeUndefined();
  });
});
