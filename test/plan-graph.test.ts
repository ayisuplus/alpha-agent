// P3 plan-graph behavior (docs/plan-graph-and-expert-state-2026-09-29.md §3, §7, §8): the three-stage skeleton opens in
// order, dependencies gate entry, exit conditions are runtime-checked per node type, pause hangs on the node and
// resumes into it, access is derived from the node type, and pre-rename `plan/revised` logs still fold.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskLedger,
  type CognitionState,
  type PlanEdge,
  type PlanNode,
  type PlanNodeKind,
  type TaskState,
} from "../src/runtime/task-ledger";
import { foldTask, type TaskEvent, type TaskEventPayloads } from "../src/runtime/task-events";

function node(id: string, kind: PlanNodeKind, phase: PlanNodeKind, dependsOn: string[], extra: Partial<PlanNode> = {}): PlanNode {
  return {
    id, kind, phase, objective: `Work on ${id}`, dependsOn,
    expertDecision: { reason: "the coordinator works this node itself" },
    host: "coordinator", skillIds: [], status: "planned", ...extra,
  };
}

const statusOf = (ledger: TaskLedger, id: string) => ledger.state.cognition!.nodes.find(item => item.id === id)!.status;

/** A general task with an auto-approved three-phase plan, ready for node lifecycle calls. */
async function withPlan(nodes: PlanNode[], run: (ledger: TaskLedger, project: string) => Promise<void>, edges?: PlanEdge[]): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "alpha-plan-graph-"));
  try {
    const project = join(root, "product");
    await Bun.write(join(project, "app.txt"), "v1");
    const ledger = await TaskLedger.create(join(root, "state"), {
      objective: "Ship the plan graph", projectRoot: project, taskType: "general", criteria: [],
    });
    await ledger.reviseCognition({ summary: "Planned task work", reason: "task start", candidates: [], nodes, ...(edges ? { edges } : {}) });
    // 自动批准 records the plan and moves the task into execution in the same run (§0).
    expect(ledger.state.phase).toBe("execute");
    await run(ledger, project);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const finding = { claim: "The task needs its planned work", source: "src/app.ts:1" };

test("a stage opens only after every earlier-stage node is done", async () => {
  await withPlan([
    node("inspect", "investigate", "investigate", []),
    node("build", "execute", "execute", []),
    node("final-check", "review", "review", []),
  ], async ledger => {
    await expect(ledger.enterNode({ nodeId: "build", host: "coordinator", runId: "run-build" })).rejects.toThrow("阶段尚未开放");
    expect(statusOf(ledger, "build")).toBe("planned");
    await expect(ledger.enterNode({ nodeId: "final-check", host: "coordinator", runId: "run-check" })).rejects.toThrow("阶段尚未开放");
    expect(statusOf(ledger, "final-check")).toBe("planned");

    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect" });
    await ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], findings: [finding], note: "Investigation recorded", unresolved: [] });

    // The investigation stage is done, so the execute stage opens; the review stage stays closed while build is open.
    await ledger.enterNode({ nodeId: "build", host: "coordinator", runId: "run-build" });
    expect(statusOf(ledger, "build")).toBe("active");
    await expect(ledger.enterNode({ nodeId: "final-check", host: "coordinator", runId: "run-check" })).rejects.toThrow("阶段尚未开放");
    await ledger.exitNode({ nodeId: "build", runId: "run-build", artifacts: [], note: "Work delivered", unresolved: [] });

    await ledger.enterNode({ nodeId: "final-check", host: "coordinator", runId: "run-check" });
    expect(statusOf(ledger, "final-check")).toBe("active");
  });
});

test("a node cannot enter while a dependency is open", async () => {
  await withPlan([
    node("inspect", "investigate", "investigate", []),
    node("base", "execute", "execute", []),
    node("follow", "execute", "execute", ["base"]),
    node("final-check", "review", "review", []),
  ], async ledger => {
    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect" });
    await ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], findings: [finding], note: "Investigation recorded", unresolved: [] });

    await ledger.enterNode({ nodeId: "base", host: "coordinator", runId: "run-base" });
    await expect(ledger.enterNode({ nodeId: "follow", host: "coordinator", runId: "run-follow" })).rejects.toThrow("前置未完成");
    expect(statusOf(ledger, "follow")).toBe("planned");

    await ledger.exitNode({ nodeId: "base", runId: "run-base", artifacts: [], note: "Base work delivered", unresolved: [] });
    expect(statusOf(ledger, "follow")).toBe("ready");
    await ledger.enterNode({ nodeId: "follow", host: "coordinator", runId: "run-follow" });
    expect(statusOf(ledger, "follow")).toBe("active");
  });
});

test("an execute node cannot exit without the artifacts it declares, and a hash mismatch refuses the handoff", async () => {
  await withPlan([
    node("inspect", "investigate", "investigate", []),
    node("build", "execute", "execute", ["inspect"], { produces: ["script"] }),
    node("final-check", "review", "review", ["build"]),
  ], async (ledger, project) => {
    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect" });
    await ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], findings: [finding], note: "Investigation recorded", unresolved: [] });
    await ledger.enterNode({ nodeId: "build", host: "coordinator", runId: "run-build" });

    await expect(ledger.exitNode({ nodeId: "build", runId: "run-build", artifacts: [], note: "Done without artifacts", unresolved: [] })).rejects.toThrow("缺少声明的产物：script");
    // A refused exit leaves the node open; only a satisfied exit may settle it to done.
    expect(statusOf(ledger, "build")).toBe("active");

    const contents = "console.log('cart total');\n";
    await writeFile(join(project, "script.js"), contents);
    await expect(ledger.exitNode({ nodeId: "build", runId: "run-build", artifacts: [{ path: "script.js", hash: "0".repeat(64), kind: "script" }], note: "Done", unresolved: [] })).rejects.toThrow("哈希不符");
    expect(statusOf(ledger, "build")).toBe("active");

    const hash = createHash("sha256").update(contents).digest("hex");
    await ledger.exitNode({ nodeId: "build", runId: "run-build", artifacts: [{ path: "script.js", hash, kind: "script" }], note: "Script delivered", unresolved: [] });
    expect(statusOf(ledger, "build")).toBe("done");
    expect(ledger.state.cognition!.nodes.find(item => item.id === "build")!.handoff?.artifacts).toEqual([{ path: "script.js", hash, kind: "script" }]);
  });
});

test("a review node cannot exit without a verdict citing evidence", async () => {
  await withPlan([
    node("inspect", "investigate", "investigate", []),
    node("build", "execute", "execute", ["inspect"]),
    node("final-check", "review", "review", ["build"]),
  ], async ledger => {
    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect" });
    await ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], findings: [finding], note: "Investigation recorded", unresolved: [] });
    await ledger.enterNode({ nodeId: "build", host: "coordinator", runId: "run-build" });
    await ledger.exitNode({ nodeId: "build", runId: "run-build", artifacts: [], note: "Work delivered", unresolved: [] });
    await ledger.enterNode({ nodeId: "final-check", host: "coordinator", runId: "run-check" });

    await expect(ledger.exitNode({ nodeId: "final-check", runId: "run-check", artifacts: [], note: "Checked", unresolved: [] })).rejects.toThrow("必须给出 gate 结论");
    await expect(ledger.exitNode({ nodeId: "final-check", runId: "run-check", artifacts: [], verdict: "pass", note: "Checked", unresolved: [] })).rejects.toThrow("必须引用产物或源码原文");
    await expect(ledger.exitNode({ nodeId: "final-check", runId: "run-check", artifacts: [], verdict: "pass", findings: [{ claim: "Looks fine", source: "   " }], note: "Checked", unresolved: [] })).rejects.toThrow("必须引用产物或源码原文");
    expect(statusOf(ledger, "final-check")).toBe("active");

    await ledger.exitNode({ nodeId: "final-check", runId: "run-check", artifacts: [], verdict: "pass", findings: [{ claim: "The delivery matches its objective", source: "script.js:1" }], note: "Gate passed", unresolved: [] });
    expect(statusOf(ledger, "final-check")).toBe("done");
  });
});

test("an investigation node cannot exit without sourced findings", async () => {
  await withPlan([
    node("inspect", "investigate", "investigate", []),
    node("build", "execute", "execute", ["inspect"]),
    node("final-check", "review", "review", ["build"]),
  ], async ledger => {
    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect" });

    await expect(ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], note: "Looked around", unresolved: [] })).rejects.toThrow("逐条带依据");
    await expect(ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], findings: [{ claim: "No source recorded", source: "" }], note: "Looked around", unresolved: [] })).rejects.toThrow("逐条带依据");
    expect(statusOf(ledger, "inspect")).toBe("active");

    await ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], findings: [finding], note: "Investigation recorded", unresolved: [] });
    expect(statusOf(ledger, "inspect")).toBe("done");
    expect(ledger.state.cognition!.nodes.find(item => item.id === "inspect")!.handoff?.findings).toEqual([finding]);
  });
});

test("a waiting node resumes by entering the same node again", async () => {
  await withPlan([
    node("inspect", "investigate", "investigate", []),
    node("build", "execute", "execute", ["inspect"]),
    node("final-check", "review", "review", ["build"]),
  ], async ledger => {
    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect" });
    await ledger.waitNode("inspect", "question");
    expect(statusOf(ledger, "inspect")).toBe("waiting");
    expect(ledger.state.cognition!.nodes.find(item => item.id === "inspect")!.statusReason).toBe("question");

    // The pause hangs on the node; resuming returns the cursor to the same node.
    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect-again" });
    expect(statusOf(ledger, "inspect")).toBe("active");
    expect(ledger.state.cognition!.nodes.find(item => item.id === "inspect")!.activation?.runId).toBe("run-inspect-again");
  });
});

test("node type derives access: review nodes run read-only and execute nodes write", async () => {
  await withPlan([
    node("inspect", "investigate", "investigate", []),
    node("build", "execute", "execute", ["inspect"]),
    node("final-check", "review", "review", ["build"]),
  ], async ledger => {
    await ledger.enterNode({ nodeId: "inspect", host: "coordinator", runId: "run-inspect" });
    expect(ledger.state.cognition!.nodes.find(item => item.id === "inspect")!.activation?.access).toBe("read-only");
    await ledger.exitNode({ nodeId: "inspect", runId: "run-inspect", artifacts: [], findings: [finding], note: "Investigation recorded", unresolved: [] });
    await ledger.enterNode({ nodeId: "build", host: "coordinator", runId: "run-build" });
    expect(ledger.state.cognition!.nodes.find(item => item.id === "build")!.activation?.access).toBe("write");
    await ledger.exitNode({ nodeId: "build", runId: "run-build", artifacts: [], note: "Work delivered", unresolved: [] });
    await ledger.enterNode({ nodeId: "final-check", host: "coordinator", runId: "run-check" });
    expect(ledger.state.cognition!.nodes.find(item => item.id === "final-check")!.activation?.access).toBe("read-only");
  });
});

function codeOf(run: () => unknown): string {
  try { run(); return "no error"; } catch (error) { return (error as { code?: string }).code ?? String(error); }
}

function handState(id: string, nodes: PlanNode[]): TaskState {
  const cognition: CognitionState = { revision: 1, recipeVersion: 1, summary: "Check the result", candidates: [], nodes, gaps: [], amendments: [] };
  return {
    id, objective: "Ship the plan graph", contractVersion: 1, contractHistory: [], guidanceHistory: [], cognition,
    projectRoot: "project", criteria: [], status: "active", phase: "execute",
    revision: "a".repeat(64), evidence: [], runs: [], preview: null,
    createdAt: "2026-09-29T08:00:00.000Z", updatedAt: "2026-09-29T08:00:00.000Z",
  };
}

test("the node/entered reducer rejects an access tier the node type does not allow", () => {
  const entered = (nodeId: string, access: "read-only" | "write"): TaskEvent => ({
    seq: 2, at: "2026-09-29T08:01:00.000Z", actor: "coordinator", type: "node/entered",
    payload: { nodeId, host: "coordinator", runId: "run-1", access, startedAt: "2026-09-29T08:01:00.000Z" },
  });
  const created = (nodes: PlanNode[]): TaskEvent => ({
    seq: 1, at: "2026-09-29T08:00:00.000Z", actor: "runtime", type: "task/created", payload: { state: handState("task-1", nodes) },
  });

  // A review node is read-only (§7): a payload demanding write is refused...
  expect(codeOf(() => foldTask([created([node("check", "review", "review", [])]), entered("check", "write")]))).toBe("apply/node-access-mismatch");
  // ...as is the mirror: an execute node never runs read-only.
  expect(codeOf(() => foldTask([created([node("build", "execute", "execute", [])]), entered("build", "read-only")]))).toBe("apply/node-access-mismatch");
  // Derived access records the entry.
  const folded = foldTask([created([node("check", "review", "review", [])]), entered("check", "read-only")]);
  expect(folded.cognition!.nodes[0].status).toBe("active");
  expect(folded.cognition!.nodes[0].activation?.access).toBe("read-only");
});

test("folding the same in-memory events twice is pure over the input payloads", () => {
  const state = handState("task-1", []);
  const events: TaskEvent[] = [
    { seq: 1, at: "2026-09-29T08:00:00.000Z", actor: "runtime", type: "task/created", payload: { state } },
    { seq: 2, at: "2026-09-29T08:01:00.000Z", actor: "runtime", type: "graph/skeleton-created", payload: { stages: ["investigate", "execute", "review"] } },
    { seq: 3, at: "2026-09-29T08:02:00.000Z", actor: "runtime", type: "capability-gap/recorded", payload: { kind: "tool", description: "No CSV fixture generator", recordedAt: "2026-09-29T08:02:00.000Z" } },
    { seq: 4, at: "2026-09-29T08:03:00.000Z", actor: "runtime", type: "goal/changed", payload: { goal: { enabled: true, noProgressRuns: 0, revision: 1 } } },
    { seq: 5, at: "2026-09-29T08:04:00.000Z", actor: "runtime", type: "guidance/recorded", payload: { guidance: { id: "guide-1", instruction: "Keep the public API unchanged", recordedAt: "2026-09-29T08:04:00.000Z", status: "recorded" } } },
    { seq: 6, at: "2026-09-29T08:05:00.000Z", actor: "runtime", type: "guidance/status-changed", payload: { id: "guide-1", status: "delivered" } },
  ];
  const snapshot = structuredClone(events);

  const first = foldTask(events);
  const second = foldTask(events);
  expect(second).toEqual(first);
  expect(first.cognition!.stages).toEqual(["investigate", "execute", "review"]);
  expect(first.cognition!.gaps.map(gap => gap.description)).toEqual(["No CSV fixture generator"]);
  expect(first.goal).toEqual({ enabled: true, noProgressRuns: 0, revision: 1 });
  expect(first.guidanceHistory).toEqual([{ id: "guide-1", instruction: "Keep the public API unchanged", recordedAt: "2026-09-29T08:04:00.000Z", status: "delivered" }]);
  // Strict input purity: reducers write only into the folded state — the event payloads are read-only history,
  // including the records later events mutate (the guidance above is "delivered" in the state, "recorded" in the log).
  expect(events).toEqual(snapshot);
});

test("a legacy plan/revised log still folds into execute-stage nodes", () => {
  const created: TaskEvent = {
    seq: 1, at: "2026-09-29T08:00:00.000Z", actor: "runtime", type: "task/created", payload: { state: handState("task-1", []) },
  };
  // The pre-rename payload spelling: `steps` with `mode` and old statuses, no stages or expert decisions (§8 旧任务).
  const legacyInput = {
    summary: "Legacy plan", candidates: ["backend"], reason: "imported before the plan graph",
    steps: [
      { id: "s1", objective: "Read the cart code", mode: "investigate", dependsOn: [], skillIds: [], expertId: "backend", status: "complete" },
      { id: "s2", objective: "Fix the rounding", mode: "implement", dependsOn: ["s1"], skillIds: [], status: "running" },
      { id: "s3", objective: "Held on tests", mode: "implement", dependsOn: ["s2"], skillIds: [], status: "blocked" },
      { id: "s4", objective: "Check the fix", mode: "review", dependsOn: ["s3"], skillIds: [], status: "planned" },
      { id: "s5", objective: "Scratch work", mode: "implement", dependsOn: [], skillIds: [], status: "cancelled" },
    ],
  } as unknown as TaskEventPayloads["plan/revised"]["input"];
  const revised: TaskEvent = {
    seq: 2, at: "2026-09-29T08:01:00.000Z", actor: "runtime", type: "plan/revised",
    payload: { input: legacyInput, recordedAt: "2026-09-29T08:01:00.000Z" },
  };

  const folded = foldTask([created, revised]);
  const nodes = folded.cognition!.nodes;
  expect(nodes.map(item => [item.id, item.kind, item.phase, item.status])).toEqual([
    ["s1", "investigate", "execute", "done"],
    ["s2", "execute", "execute", "active"],
    ["s3", "execute", "execute", "waiting"],
    ["s4", "review", "execute", "planned"],
    ["s5", "execute", "execute", "cancelled"],
  ]);
  expect(nodes[0].expertDecision).toEqual({ expertId: "backend", reason: "历史计划（旧格式步骤）" });
  expect(folded.cognition!.amendments[0].affectedNodes).toEqual(["s1", "s2", "s3", "s4", "s5"]);
});

// P4 back-edges, staleness and projections (§3.5, §3.7, §3.8, §6.2, §6.3).

test("a changes-requested verdict walks the rework edge automatically and pauses after two rounds", async () => {
  await withPlan([
    node("scan", "investigate", "investigate", []),
    node("work", "execute", "execute", ["scan"], { produces: ["report"] }),
    node("gate", "review", "review", ["work"]),
  ], async (ledger, project) => {
    const report = async (body: string, run: string) => {
      await writeFile(join(project, "report.md"), body);
      await ledger.enterNode({ nodeId: "work", host: "coordinator", runId: run });
      await ledger.exitNode({ nodeId: "work", runId: run, artifacts: [{ path: "report.md", hash: createHash("sha256").update(body).digest("hex"), kind: "report" }], note: `Wrote ${body}`, unresolved: [] });
    };
    const review = async (run: string) => {
      await ledger.enterNode({ nodeId: "gate", host: "coordinator", runId: run });
      await ledger.exitNode({ nodeId: "gate", runId: run, artifacts: [], findings: [{ claim: "The report is wrong", source: "report.md" }], verdict: "changes-requested", note: "Redo the report", unresolved: [] });
    };
    await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "r1" });
    await ledger.exitNode({ nodeId: "scan", runId: "r1", artifacts: [], findings: [finding], note: "Scanned", unresolved: [] });
    await report("report v1", "r1");
    await review("r1");
    // Each changes-requested walks the declared rework edge and reopens the execute node automatically (§3.5).
    expect(statusOf(ledger, "work")).toBe("reopened");
    await report("report v2", "r2");
    // The gate's verdict expires against the new report, so the coordinator re-reviews it (§6.2).
    expect(ledger.state.cognition!.nodes.find(item => item.id === "gate")!.stale).toBe(true);
    await ledger.reopenNode({ nodeId: "gate", reason: "重新审查新报告" });
    await review("r2");
    expect(statusOf(ledger, "work")).toBe("reopened");
    // Two automatic rounds are the cap; the third changes-requested pauses for the user instead of looping.
    await report("report v3", "r3");
    await ledger.reopenNode({ nodeId: "gate", reason: "重新审查新报告" });
    await review("r3");
    expect(statusOf(ledger, "work")).toBe("done");
    expect(ledger.state.status).toBe("needs-input");
    expect(ledger.state.pauseReason).toBe("question");
  }, [{ from: "gate", to: "work", kind: "rework" }]);
});

test("a premise back-edge marks downstream work stale when the redo changes its outputs", async () => {
  await withPlan([
    node("scan", "investigate", "investigate", []),
    node("work", "execute", "execute", ["scan"]),
    node("check", "review", "review", ["work"]),
  ], async ledger => {
    await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "r1" });
    await ledger.exitNode({ nodeId: "scan", runId: "r1", artifacts: [], findings: [{ claim: "Premise A holds", source: "src/app.ts:1" }], note: "Scanned", unresolved: [] });
    await ledger.enterNode({ nodeId: "work", host: "coordinator", runId: "r1" });
    await ledger.exitNode({ nodeId: "work", runId: "r1", artifacts: [], note: "Worked from premise A", unresolved: [] });
    await ledger.enterNode({ nodeId: "check", host: "coordinator", runId: "r1" });
    await ledger.exitNode({ nodeId: "check", runId: "r1", artifacts: [], findings: [{ claim: "Work matches premise A", source: "src/app.ts:1" }], verdict: "pass", note: "Checked", unresolved: [] });
    // The premise broke: walk the declared premise edge back to the investigation (§3.5).
    await ledger.reopenNode({ nodeId: "scan", edge: "premise", sourceNodeId: "work", reason: "前提有误：输入数据已更换" });
    expect(statusOf(ledger, "scan")).toBe("reopened");
    await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "r2" });
    await ledger.exitNode({ nodeId: "scan", runId: "r2", artifacts: [], findings: [{ claim: "Premise B holds", source: "src/app.ts:2" }], note: "Re-scanned under premise B", unresolved: [] });
    // What downstream consumed changed: both finished downstream nodes are stale, the coordinator decides next (§3.5).
    const nodes = ledger.state.cognition!.nodes;
    expect(nodes.find(item => item.id === "work")!.stale).toBe(true);
    expect(nodes.find(item => item.id === "check")!.stale).toBe(true);
    // A stale gate verdict is expired: the gate gap blocks completion until it is re-reviewed (§6.2).
    expect(ledger.completionGaps()).toContain("gate");
    // Keeping stale work needs no call; redoing it reopens the node and clears its mark.
    await ledger.reopenNode({ nodeId: "work", reason: "按前提 B 重做" });
    expect(statusOf(ledger, "work")).toBe("reopened");
    expect(nodes.find(item => item.id === "work")!.stale).toBe(false);
  }, [{ from: "work", to: "scan", kind: "premise" }]);
});

test("a revision cannot rewrite or drop a node that has been entered", async () => {
  await withPlan([
    node("scan", "investigate", "investigate", []),
    node("work", "execute", "execute", []),
    node("check", "review", "review", ["work"]),
  ], async ledger => {
    await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "r1" });
    await expect(ledger.reviseCognition({
      summary: "Rewrite it", reason: "Invalid", candidates: [],
      nodes: [node("scan", "investigate", "investigate", [], { objective: "Different work" }), node("work", "execute", "execute", []), node("check", "review", "review", ["work"])],
    })).rejects.toThrow("不可改写");
    await expect(ledger.reviseCognition({
      summary: "Drop it", reason: "Invalid", candidates: [],
      nodes: [node("work", "execute", "execute", []), node("check", "review", "review", ["work"])],
    })).rejects.toThrow("不可改写");
    expect(statusOf(ledger, "scan")).toBe("active");
  });
});

test("a user-designated expert is the same graph constraint for dispatch and non-dispatch task types", async () => {
  for (const taskType of ["code-change", "general"] as const) {
    const root = await mkdtemp(join(tmpdir(), "alpha-designated-graph-"));
    try {
      const project = join(root, "product");
      await Bun.write(join(project, "app.txt"), "v1");
      const ledger = await TaskLedger.create(join(root, "state"), {
        objective: "Use the chosen expert", projectRoot: project, taskType, designatedExpertId: "expert-chosen",
        criteria: taskType === "general" ? [] : [{ id: "check", description: "Check passes", kind: "test" }],
      });
      await ledger.reviseCognition({
        summary: "Plan with the chosen expert", reason: "user selection", candidates: ["expert-chosen"],
        nodes: [
          node("scan", "investigate", "investigate", []),
          node("work", "execute", "execute", ["scan"], { expertDecision: { expertId: "expert-chosen", reason: "User selection" } }),
          node("check", "review", "review", ["work"]),
        ],
      });
      await ledger.enterNode({ nodeId: "scan", host: "coordinator", runId: "r1" });
      await ledger.exitNode({ nodeId: "scan", runId: "r1", artifacts: [], findings: [finding], note: "Scanned", unresolved: [] });
      await ledger.enterNode({ nodeId: "work", host: "coordinator", runId: "r1" });
      await ledger.exitNode({ nodeId: "work", runId: "r1", artifacts: [], note: "Worked with the chosen expert", unresolved: [] });
      await ledger.enterNode({ nodeId: "check", host: "coordinator", runId: "r1" });
      await ledger.exitNode({ nodeId: "check", runId: "r1", artifacts: [], findings: [{ claim: "Work matches", source: "src/app.ts:1" }], verdict: "pass", note: "Checked", unresolved: [] });
      if (taskType !== "general") await ledger.recordEvidence({ criterionId: "check", kind: "test", passed: true, revision: ledger.state.revision!, source: "check.log" });
      // The designated expert's node is done under the current contract: the graph constraint holds (§6.3).
      expect(ledger.completionGaps()).toEqual([]);
      // A revised contract ends that participation; both task types block identically until the expert works again.
      await ledger.reviseObjective("Use the chosen expert differently");
      expect(ledger.completionGaps()).toContain("plan-graph");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
