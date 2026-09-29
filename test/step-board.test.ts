import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTaskInvariants } from "../src/runtime/task-invariants";
import { TaskLedger } from "../src/runtime/task-ledger";
import { readEvents, taskLogDir } from "../src/runtime/task-events";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "alpha-step-board-"));
}

async function newTask(root: string): Promise<TaskLedger> {
  const projectRoot = join(root, "project");
  await Bun.write(join(projectRoot, "app.txt"), "v1");
  const ledger = await TaskLedger.create(join(root, "data"), {
    objective: "Ship the board", projectRoot, taskType: "code-change",
    criteria: [{ id: "check", description: "Checks pass", kind: "test" }],
  });
  await ledger.reviseCognition({
    summary: "One node, two writers", reason: "Initial plan", candidates: [],
    nodes: [
      { id: "inspect-a", objective: "Check what ships", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "the coordinator investigates itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "step-a", objective: "Deliver step-a", kind: "execute", phase: "execute", dependsOn: ["inspect-a"], expertDecision: { reason: "the coordinator works itself" }, host: "coordinator", skillIds: [], status: "planned" },
      { id: "check-a", objective: "Check the delivery", kind: "review", phase: "review", dependsOn: ["step-a"], expertDecision: { reason: "the coordinator checks itself" }, host: "coordinator", skillIds: [], status: "planned" },
    ],
  });
  await ledger.enterNode({ nodeId: "inspect-a", host: "coordinator", runId: "run-0" });
  await ledger.exitNode({ nodeId: "inspect-a", runId: "run-0", artifacts: [], findings: [{ claim: "Ready to ship", source: "app.txt" }], note: "Checked what ships", unresolved: [] });
  return ledger;
}

test("concurrent node entries resolve through the append-only log", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    // Two handles on one log race for the same node: exactly one entry wins, and the loser is rejected before any
    // event of its own is written (models never report node status; the log derives it).
    const first = await TaskLedger.load(ledger.file);
    const second = await TaskLedger.load(ledger.file);
    const results = await Promise.allSettled([
      first.enterNode({ nodeId: "step-a", host: "coordinator", runId: "run-1" }),
      second.enterNode({ nodeId: "step-a", host: "coordinator", runId: "run-2" }),
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const losers = results.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(losers).toHaveLength(1);
    expect(String(losers[0].reason)).toContain("节点当前状态不能进入");
    const entered = (await readEvents(taskLogDir(ledger.file))).filter(event => event.type === "node/entered" && "nodeId" in event.payload && event.payload.nodeId === "step-a");
    expect(entered).toHaveLength(1);
    const reloaded = await TaskLedger.load(ledger.file);
    const node = reloaded.state.cognition!.nodes.find(item => item.id === "step-a")!;
    expect(node).toMatchObject({ status: "active" });
    expect(["run-1", "run-2"]).toContain(node.claimedBy ?? "");
    expect(node.activation?.runId).toBe(node.claimedBy);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a claimed node whose instance was reconciled passes the running-instance invariant", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    await ledger.recordDispatch({ id: "inst-1", orderId: "step-a", kind: "execute", skills: [] });
    // The restart reconciles the in-flight attempt; the node is left behind as active with a claim on it.
    await ledger.reconcileRunningInstances("process restarted");
    expect(ledger.state.cognition?.instances?.[0]?.status).toBe("failed");
    const node = ledger.state.cognition!.nodes.find(item => item.id === "step-a")!;
    node.status = "active";
    node.claimedBy = "inst-1";
    const codes = () => checkTaskInvariants(ledger.state).map(item => item.code);
    // The claim names an instance that exists and ended: no violation.
    expect(codes()).not.toContain("S/step-running-without-instance");
    // A claim naming an instance that never existed does not excuse the active node.
    node.claimedBy = "ghost";
    expect(codes()).toContain("S/step-running-without-instance");
    // Neither a live instance nor a claim: the violation stands.
    delete node.claimedBy;
    expect(codes()).toContain("S/step-running-without-instance");
    // Negative board revisions are their own I7 violation.
    node.revision = -1;
    expect(codes()).toContain("I7/step-revision-negative");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
