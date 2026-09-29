import { describe, expect, test } from "bun:test";
import type { CognitionState, PlanNode, TaskState } from "../src/runtime/task-ledger";
import { graphReducers } from "../src/runtime/task-events/apply/graph";
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

function applyGraph<Type extends TaskEventType>(state: TaskState, type: Type, payload: TaskEventOf<Type>["payload"]): void {
  const reducer = graphReducers[type] as ((state: TaskState, event: TaskEventOf<Type>) => void) | undefined;
  if (!reducer) throw new Error(`graphReducers has no reducer for ${type}`);
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

function node(id: string, overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    id, objective: `Deliver ${id}`, kind: "execute", phase: "execute", dependsOn: [],
    expertDecision: { reason: "the coordinator works this node itself" }, host: "coordinator",
    skillIds: [], status: "planned", ...overrides,
  };
}

/** Stage fillers (§3.2): thin plans grow one node per missing skeleton stage so a new-format revision validates. */
function fillNode(): PlanNode {
  return node("fill", { kind: "investigate", phase: "investigate", objective: "Fill the investigate stage" });
}

function checkNode(): PlanNode {
  return node("check", { kind: "review", phase: "review", objective: "Check the result" });
}

/** A new-format plan literal: the given nodes plus the stage fillers they are missing. */
function plan(...nodes: PlanNode[]): PlanNode[] {
  return [
    ...(nodes.some(item => item.phase === "investigate") ? [] : [fillNode()]),
    ...nodes,
    ...(nodes.some(item => item.phase === "review") ? [] : [checkNode()]),
  ];
}

function cognition(overrides: Partial<CognitionState> = {}): CognitionState {
  return { revision: 1, recipeVersion: 1, summary: "Plan summary", candidates: [], nodes: [], gaps: [], amendments: [], ...overrides };
}

type ReviseInput = TaskEventOf<"plan/revised">["payload"]["input"];

function reviseInput(overrides: Partial<ReviseInput> = {}): ReviseInput {
  return { summary: "Revised summary", candidates: ["expert-a"], nodes: plan(node("build-api")), reason: "Split the work", ...overrides };
}

describe("plan/submitted", () => {
  test("requires the plan phase with nonempty steps", () => {
    const wrongPhase = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a")], basedOnRevision: "rev-1" }) });
    expectInvariant(() => apply(wrongPhase, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
    expect(wrongPhase.phase).toBe("execute");
    // The phase/plan gate wins over the revision gate.
    const staleWrongPhase = baseState({ phase: "execute", cognition: cognition({ nodes: [], basedOnRevision: "stale" }) });
    expectInvariant(() => apply(staleWrongPhase, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
    const emptyPlan = baseState({ phase: "plan", cognition: cognition({ nodes: [] }) });
    expectInvariant(() => apply(emptyPlan, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
    const noCognition = baseState({ phase: "plan" });
    expectInvariant(() => apply(noCognition, "plan/submitted", {}), "apply/plan-empty", "A nonempty plan is required for review");
  });

  test("requires a plan based on the current source revision", () => {
    const state = baseState({ phase: "plan", cognition: cognition({ nodes: [node("a")], basedOnRevision: "rev-0" }) });
    expectInvariant(
      () => apply(state, "plan/submitted", {}),
      "apply/plan-source-moved",
      "Project changed after planning; review the current source and revise the plan",
    );
    expect(state.phase).toBe("plan");
  });

  test("flips to plan-review when the plan matches the source", () => {
    const state = baseState({ phase: "plan", cognition: cognition({ nodes: [node("a")], basedOnRevision: "rev-1" }) });
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
        nodes: [
          node("build-api", { status: "active", statusReason: "工单 wo-1 运行中" }),
          node("write-tests", { status: "done", statusReason: "done" }),
          node("docs", { status: "planned", statusReason: "later" }),
        ],
        amendments: [{ revision: 3, reason: "earlier", affectedNodes: ["build-api"], recordedAt: "2026-09-27T00:00:00.000Z" }],
      }),
    });
    apply(state, "plan/revised", {
      input: reviseInput({
        nodes: plan(
          node("build-api", { status: "planned", statusReason: "stale" }),
          node("write-tests"),
          node("docs"),
          node("ship-it", { dependsOn: ["build-api"] }),
        ),
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
    // Entered/finished statuses and reasons survive even when the input resets them; the untouched fillers derive "ready".
    expect(next.nodes.map(item => [item.id, item.status, item.statusReason])).toEqual([
      ["fill", "ready", undefined],
      ["build-api", "active", "工单 wo-1 运行中"],
      ["write-tests", "done", "done"],
      ["docs", "planned", "later"],
      ["ship-it", "planned", undefined],
      ["check", "planned", undefined],
    ]);
    expect(next.amendments).toEqual([
      { revision: 3, reason: "earlier", affectedNodes: ["build-api"], recordedAt: "2026-09-27T00:00:00.000Z" },
      { revision: 4, reason: "Split the work", affectedNodes: ["fill", "build-api", "write-tests", "docs", "ship-it", "check"], recordedAt: AT },
    ]);
    // no planApproval: no phase flip
    expect(state.phase).toBe("execute");
    expect(state.planApproval).toBeUndefined();
  });

  test("a material change drops the approval and returns to plan-review", () => {
    const approval = { contractVersion: 1, cognitionRevision: 1, sourceRevision: "rev-1", approvedAt: AT };
    const state = baseState({ phase: "execute", planApproval: approval, cognition: cognition({ nodes: plan(node("build-api")) }) });
    apply(state, "plan/revised", {
      input: reviseInput({ nodes: plan(node("build-api"), node("extra-step")) }),
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
      cognition: cognition({ scope: ["scope-a"], nodes: plan(node("build-api"), node("docs")) }),
    });
    // Identical node definitions, unchanged scope/constraints (undefined falls back), only the summary differs.
    apply(state, "plan/revised", {
      input: reviseInput({ nodes: plan(node("build-api"), node("docs")) }),
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
      cognition: cognition({ nodes: [fillNode(), node("build-api"), node("docs", { kind: "investigate", phase: "investigate" }), checkNode()] }),
    });
    apply(state, "plan/revised", {
      input: reviseInput({ nodes: [fillNode(), node("build-api"), node("docs"), checkNode()] }),
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
        input: reviseInput({ nodes: Array.from({ length: 21 }, (_, i) => node(`s${i}`)) }),
        recordedAt: AT,
      }),
      "apply/cognition-content-invalid",
      "认知修订内容无效",
    );
    // A new-format revision must fill all three skeleton stages (§3.2).
    const emptyStages = baseState({ cognition: cognition() });
    expectInvariant(
      () => apply(emptyStages, "plan/revised", { input: reviseInput({ nodes: [node("build-api")] }), recordedAt: AT }),
      "apply/plan-stage-empty",
      "调查、执行、审查三个阶段都必须至少有一个节点",
    );
  });

  test("rejects malformed steps", () => {
    const cases: PlanNode[][] = [
      [node("dup"), node("dup", { objective: "other" })],
      [node("Bad-Case")],
      [node("coordinator")],
      [node("final-review")],
      [node("review-repair")],
      [node("blank", { objective: "  " })],
      [node("orphan", { dependsOn: ["ghost"] })],
      [node("self", { dependsOn: ["self"] })],
    ];
    for (const nodes of cases) {
      expectInvariant(
        () => apply(baseState({ cognition: cognition() }), "plan/revised", { input: reviseInput({ nodes: plan(...nodes) }), recordedAt: AT }),
        "apply/cognition-steps-invalid",
        "认知节点无效",
      );
    }
  });

  test("detects dependency cycles", () => {
    expectInvariant(
      () => apply(baseState({ cognition: cognition() }), "plan/revised", {
        input: reviseInput({ nodes: plan(node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] })) }),
        recordedAt: AT,
      }),
      "apply/cognition-cycle",
      "认知节点存在循环依赖",
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
        input: reviseInput({ candidates: ["expert-9"], nodes: plan(node("build-api", { expertDecision: { expertId: "expert-a", reason: "expert-a owns this work" } })) }),
        recordedAt: AT,
      }),
      "apply/designated-expert-dropped",
      "用户指定专家必须保留在计划中：expert-9",
    );
    // A node carrying the designated expert keeps the candidate entry.
    const ok = baseState({ designatedExpertId: "expert-9", cognition: cognition() });
    apply(ok, "plan/revised", {
      input: reviseInput({ candidates: ["expert-9"], nodes: plan(node("build-api", { expertDecision: { expertId: "expert-9", reason: "the user picked this expert" } })) }),
      recordedAt: AT,
    });
    expect(ok.cognition!.candidates).toEqual(["expert-9"]);
  });

  test("refuses to rewrite or drop running and completed steps", () => {
    const rewritten = baseState({ cognition: cognition({ nodes: [node("build-api", { status: "active" })] }) });
    expectInvariant(
      () => apply(rewritten, "plan/revised", {
        input: reviseInput({ nodes: plan(node("build-api", { objective: "Something else" })) }),
        recordedAt: AT,
      }),
      "apply/dispatched-step-rewritten",
      "已进入或完成的节点不可改写：build-api",
    );
    const dropped = baseState({ cognition: cognition({ nodes: [node("write-tests", { status: "done" })] }) });
    expectInvariant(
      () => apply(dropped, "plan/revised", { input: reviseInput({ nodes: plan(node("build-api")) }), recordedAt: AT }),
      "apply/dispatched-step-rewritten",
      "已进入或完成的节点不可改写：write-tests",
    );
  });

  test("a first revision starts from revision 1 and cleans the lists", () => {
    const state = baseState({ revision: "rev-7" });
    apply(state, "plan/revised", {
      input: reviseInput({
        candidates: ["a", "a", "b"],
        constraints: [" dup ", "dup", ""],
        openQuestions: ["q1"],
        nodes: plan(node("build-api")),
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

  test("carries step revisions and claims over by id", () => {
    const state = baseState({
      phase: "execute",
      cognition: cognition({
        nodes: [
          node("build-api", { status: "active", statusReason: "工单 wo-1 运行中", revision: 3, claimedBy: "inst-1" }),
          node("docs", { status: "planned", revision: 1 }),
        ],
      }),
    });
    apply(state, "plan/revised", {
      // The input resets the board fields; the reducer must restore them from the prior nodes.
      input: reviseInput({ nodes: plan(node("build-api", { revision: 99, claimedBy: "inst-fake" }), node("docs"), node("ship-it")) }),
      recordedAt: AT,
    });
    expect(state.cognition!.nodes.map(item => [item.id, item.status, item.revision, item.claimedBy])).toEqual([
      ["fill", "ready", undefined, undefined],
      ["build-api", "active", 3, "inst-1"],
      ["docs", "planned", 1, undefined],
      ["ship-it", "planned", undefined, undefined],
      ["check", "planned", undefined, undefined],
    ]);
  });

  test("refuses to rewrite or drop a claimed step", () => {
    const rewritten = baseState({ cognition: cognition({ nodes: [node("build-api", { status: "waiting", claimedBy: "inst-1" })] }) });
    expectInvariant(
      () => apply(rewritten, "plan/revised", {
        input: reviseInput({ nodes: plan(node("build-api", { objective: "Something else" })) }),
        recordedAt: AT,
      }),
      "apply/dispatched-step-rewritten",
      "已进入或完成的节点不可改写：build-api",
    );
    const dropped = baseState({ cognition: cognition({ nodes: [node("write-tests", { claimedBy: "inst-2" })] }) });
    expectInvariant(
      () => apply(dropped, "plan/revised", { input: reviseInput({ nodes: plan(node("build-api")) }), recordedAt: AT }),
      "apply/dispatched-step-rewritten",
      "已进入或完成的节点不可改写：write-tests",
    );
    // An unchanged claimed node passes and keeps its claim.
    const kept = baseState({ cognition: cognition({ nodes: [node("build-api", { claimedBy: "inst-1" })] }) });
    apply(kept, "plan/revised", { input: reviseInput({ nodes: plan(node("build-api")) }), recordedAt: AT });
    expect(kept.cognition!.nodes.find(item => item.id === "build-api")).toMatchObject({ claimedBy: "inst-1", status: "planned" });
  });

  test("a legacy plan/revised history with input.steps still folds into execute-stage nodes", () => {
    const state = baseState({ phase: "execute" });
    // Old logs are untyped JSON: `input.steps` with `mode` keys and pre-graph statuses (§8 旧任务).
    const legacy = {
      summary: "历史计划", candidates: ["expert-a"], reason: "历史任务回放",
      steps: [
        { id: "build-api", objective: "Deliver build-api", mode: "implement", dependsOn: [], skillIds: [], status: "complete", expertId: "expert-a" },
        { id: "survey", objective: "Survey the codebase", mode: "investigate", dependsOn: [], skillIds: [], status: "running" },
        { id: "docs", objective: "Deliver docs", mode: "implement", dependsOn: ["build-api"], skillIds: [], status: "blocked" },
        { id: "ship-it", objective: "Deliver ship-it", mode: "implement", dependsOn: ["docs"], skillIds: [], status: "planned" },
      ],
    };
    apply(state, "plan/revised", { input: legacy as unknown as TaskEventOf<"plan/revised">["payload"]["input"], recordedAt: AT });
    const nodes = state.cognition!.nodes;
    // Legacy steps read as execute-stage nodes: implement maps to execute, investigate and review keep their kind,
    // and the old status vocabulary maps onto the node lifecycle.
    expect(nodes.map(item => [item.id, item.kind, item.phase, item.status])).toEqual([
      ["build-api", "execute", "execute", "done"],
      ["survey", "investigate", "execute", "active"],
      ["docs", "execute", "execute", "waiting"],
      ["ship-it", "execute", "execute", "planned"],
    ]);
    expect(nodes[0].expertDecision).toEqual({ expertId: "expert-a", reason: "历史计划（旧格式步骤）" });
    expect(nodes[1].expertDecision).toEqual({ reason: "历史计划（旧格式步骤）" });
    expect(state.cognition!.amendments[0].affectedNodes).toEqual(["build-api", "survey", "docs", "ship-it"]);
  });
});

describe("step/changed", () => {
  test("requires an active task", () => {
    const state = baseState({ status: "stopped", cognition: cognition({ nodes: [node("a")] }) });
    expectInvariant(() => apply(state, "step/changed", { id: "a", status: "running", reason: "go" }), "apply/task-not-active", "Task is stopped");
  });

  test("requires an existing step and a non-blank reason", () => {
    const payloads = [
      { id: "ghost", status: "running" as const, reason: "go" },
      { id: "a", status: "running" as const, reason: "   " },
    ];
    for (const payload of payloads) {
      const state = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a")] }) });
      expectInvariant(() => apply(state, "step/changed", payload), "apply/step-required", "Step and reason are required");
    }
  });

  test("finished steps cannot be rewritten", () => {
    for (const status of ["done", "cancelled"] as const) {
      const state = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a", { status })] }) });
      expectInvariant(() => apply(state, "step/changed", { id: "a", status: "blocked", reason: "stuck" }), "apply/step-finished", "Finished step cannot be rewritten");
    }
  });

  test("delegated steps belong to the work order, checked before the phase gates", () => {
    const instance = {
      id: "inst-1", orderId: "a", kind: "execute" as const, skills: [], contractVersion: 1, cognitionRevision: 1,
      baseRevision: null, status: "running" as const, startedAt: AT,
    };
    const state = baseState({ phase: "plan-review", cognition: cognition({ nodes: [node("a", { status: "active" })], instances: [instance] }) });
    expectInvariant(
      () => apply(state, "step/changed", { id: "a", status: "complete", reason: "done" }),
      "apply/step-delegated",
      "Delegated step status is owned by the work order result",
    );
  });

  test("the plan phase only finishes investigation steps", () => {
    const implement = baseState({ phase: "plan", cognition: cognition({ nodes: [node("a")] }) });
    expectInvariant(
      () => apply(implement, "step/changed", { id: "a", status: "complete", reason: "done" }),
      "apply/step-plan-mode",
      "Planning can only finish investigation steps",
    );
    const investigate = baseState({ phase: "plan", cognition: cognition({ nodes: [node("a", { kind: "investigate", phase: "investigate" })] }) });
    apply(investigate, "step/changed", { id: "a", status: "complete", reason: " surveyed " });
    expect(investigate.cognition!.nodes[0]).toMatchObject({ status: "done", statusReason: "surveyed" });
  });

  test("plan-review blocks every step change", () => {
    const state = baseState({ phase: "plan-review", cognition: cognition({ nodes: [node("a", { kind: "investigate", phase: "investigate" })] }) });
    expectInvariant(() => apply(state, "step/changed", { id: "a", status: "running", reason: "go" }), "apply/plan-awaiting-review", "Plan is awaiting review");
  });

  test("completing requires complete dependencies", () => {
    const state = baseState({
      phase: "execute",
      cognition: cognition({ nodes: [node("dep", { status: "active" }), node("a", { dependsOn: ["dep"] })] }),
    });
    expectInvariant(
      () => apply(state, "step/changed", { id: "a", status: "complete", reason: "done" }),
      "apply/step-deps-incomplete",
      "Step dependencies are not complete",
    );
    const ready = baseState({
      phase: "execute",
      cognition: cognition({ nodes: [node("dep", { status: "done" }), node("a", { dependsOn: ["dep"] })] }),
    });
    apply(ready, "step/changed", { id: "a", status: "complete", reason: "done" });
    expect(ready.cognition!.nodes[1].status).toBe("done");
  });

  test("sets the trimmed reason for non-complete statuses without dependency checks", () => {
    const state = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a", { status: "active", dependsOn: ["dep"] })] }) });
    apply(state, "step/changed", { id: "a", status: "blocked", reason: " waiting on review " });
    expect(state.cognition!.nodes[0]).toMatchObject({ status: "waiting", statusReason: "waiting on review" });
  });

  test("compare-and-swap accepts a matching revision and rejects a stale one", () => {
    const matched = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a", { revision: 2 })] }) });
    apply(matched, "step/changed", { id: "a", status: "running", reason: "go", expectedRevision: 2 });
    expect(matched.cognition!.nodes[0]).toMatchObject({ status: "active", revision: 3 });
    const stale = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a", { revision: 2 })] }) });
    expectInvariant(
      () => apply(stale, "step/changed", { id: "a", status: "running", reason: "go", expectedRevision: 1 }),
      "apply/step-revision-conflict",
      "Step a moved on: expected revision 1, found 2",
    );
    // A rejected swap leaves the step untouched.
    expect(stale.cognition!.nodes[0]).toMatchObject({ status: "planned", revision: 2 });
    // A step that never moved compares against revision 0.
    const untouched = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a")] }) });
    expectInvariant(
      () => apply(untouched, "step/changed", { id: "a", status: "running", reason: "go", expectedRevision: 1 }),
      "apply/step-revision-conflict",
      "Step a moved on: expected revision 1, found 0",
    );
  });

  test("an absent expectedRevision still folds legacy events", () => {
    const state = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a", { revision: 5 })] }) });
    apply(state, "step/changed", { id: "a", status: "running", reason: "go" });
    expect(state.cognition!.nodes[0]).toMatchObject({ status: "active", revision: 6 });
  });

  test("every accepted transition bumps the revision", () => {
    const state = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a")] }) });
    apply(state, "step/changed", { id: "a", status: "running", reason: "go", expectedRevision: 0 });
    apply(state, "step/changed", { id: "a", status: "blocked", reason: "stuck", expectedRevision: 1 });
    apply(state, "step/changed", { id: "a", status: "running", reason: "retry", expectedRevision: 2 });
    expect(state.cognition!.nodes[0].revision).toBe(3);
  });

  test("records claimedBy when provided and keeps it when not", () => {
    const state = baseState({ phase: "execute", cognition: cognition({ nodes: [node("a")] }) });
    apply(state, "step/changed", { id: "a", status: "running", reason: "go", claimedBy: "inst-1" });
    expect(state.cognition!.nodes[0]).toMatchObject({ status: "active", claimedBy: "inst-1", revision: 1 });
    apply(state, "step/changed", { id: "a", status: "blocked", reason: "stuck", expectedRevision: 1 });
    expect(state.cognition!.nodes[0]).toMatchObject({ status: "waiting", claimedBy: "inst-1", revision: 2 });
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
    expect(Object.keys(state.cognition!)).toEqual(["revision", "recipeVersion", "summary", "candidates", "nodes", "gaps", "amendments"]);
    expect(state.cognition).toMatchObject({ revision: 2, recipeVersion: 1, summary: "Ship the feature", candidates: [], nodes: [], amendments: [] });
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

describe("plan/revised stall guard (B3)", () => {
  const STALL_MESSAGE = "计划修订过于频繁：三轮修订没有任何节点完成。先完成已就绪的节点并用 alpha_step 退出，或用 alpha_reopen 退回前提有误的节点；要大幅改计划就停下来等用户决定。";

  test("the fourth revision with no finished node is refused, and a finished node resets the counter", () => {
    const state = baseState({ phase: "execute", cognition: cognition({ nodes: [node("build-api")] }) });
    const revise = () => apply(state, "plan/revised", { input: reviseInput(), recordedAt: AT });
    revise();
    revise();
    revise();
    expect(state.cognition?.planStallRevisions).toBe(3);
    expectInvariant(revise, "apply/plan-stall-revision", STALL_MESSAGE);
    // The refused revision recorded nothing.
    expect(state.cognition?.revision).toBe(4);
    // A finished node is progress: the counter resets and planning works again, keeping the finished node's status.
    const build = state.cognition!.nodes.find(item => item.id === "build-api")!;
    build.status = "active";
    applyGraph(state, "node/exited", { nodeId: "build-api", runId: "run-1", artifacts: [], note: "Delivered", unresolved: [], contractVersion: 1, exitedAt: AT });
    expect(state.cognition?.planStallRevisions).toBe(0);
    revise();
    expect(state.cognition?.planStallRevisions).toBe(1);
    expect(state.cognition?.nodes.find(item => item.id === "build-api")!.status).toBe("done");
    expect(state.cognition?.revision).toBe(5);
  });
});
