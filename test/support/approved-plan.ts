import type { PlanNodeHandoff, PlanNodeKind, TaskLedger } from "../../src/runtime/task-ledger";

const FIXTURE_NODES: Array<{ id: string; objective: string; kind: PlanNodeKind; phase: PlanNodeKind; dependsOn: string[]; skillIds: string[]; exit: Pick<PlanNodeHandoff, "findings" | "verdict"> }> = [
  {
    id: "inspect", objective: "Check what the task needs", kind: "investigate", phase: "investigate", dependsOn: [],
    skillIds: [],
    exit: { findings: [{ claim: "The fixture task needs its planned work", source: "fixture" }], verdict: undefined },
  },
  {
    id: "work", objective: "Complete the task work", kind: "execute", phase: "execute", dependsOn: ["inspect"],
    skillIds: [],
    exit: { findings: undefined, verdict: undefined },
  },
  {
    id: "review", objective: "Check the result", kind: "review", phase: "review", dependsOn: ["work"],
    skillIds: [],
    exit: { verdict: "pass", findings: [{ claim: "The fixture work matches its objective", source: "fixture" }] },
  },
];

/**
 * Fixtures that model work already underway record a finished plan: one node per skeleton stage (§3.2), entered and
 * exited through the node lifecycle (§3.4), so completion and goal-cycle fixtures see an approved plan with every node
 * done and no pending plan gap. Re-planning keeps the finished nodes, so this stays idempotent.
 */
export async function recordApprovedPlan(ledger: TaskLedger): Promise<void> {
  await ledger.reviseCognition({
    summary: "Planned task work", reason: "task start", candidates: [],
    nodes: FIXTURE_NODES.map(node => ({
      id: node.id, objective: node.objective, kind: node.kind, phase: node.phase, dependsOn: [...node.dependsOn],
      expertDecision: { reason: "the coordinator works this node itself" }, host: "coordinator" as const,
      skillIds: [...node.skillIds], status: "planned" as const,
    })),
  });
  for (const node of FIXTURE_NODES) {
    if (ledger.state.cognition?.nodes.find(item => item.id === node.id)?.status === "done") continue;
    await ledger.enterNode({ nodeId: node.id, host: "coordinator", runId: "fixture-run" });
    await ledger.exitNode({ nodeId: node.id, runId: "fixture-run", artifacts: [], note: "fixture node finished", unresolved: [], ...node.exit } satisfies Omit<PlanNodeHandoff, "contractVersion">);
  }
}
