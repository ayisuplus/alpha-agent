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
    summary: "One step, two writers", reason: "Initial plan", candidates: [],
    steps: [{ id: "step-a", objective: "Deliver step-a", mode: "implement", dependsOn: [], skillIds: [], status: "planned" }],
  });
  return ledger;
}

test("concurrent updateStep calls resolve through the step compare-and-swap", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    // Two handles on one log: the second writer goes in with a stale fold and must lose the sequence swap.
    const first = await TaskLedger.load(ledger.file);
    const second = await TaskLedger.load(ledger.file);
    await Promise.all([
      first.updateStep("step-a", "running", "Picked up by the first writer"),
      second.updateStep("step-a", "blocked", "Second writer re-planned after losing the swap"),
    ]);
    const reloaded = await TaskLedger.load(ledger.file);
    expect(reloaded.state.cognition!.steps[0]).toMatchObject({ status: "blocked", revision: 2 });
    // Both transitions are in the log, each carrying the revision its writer read; the loser re-planned from the re-fold.
    const events = (await readEvents(taskLogDir(ledger.file))).filter(event => event.type === "step/changed");
    expect(events.map(event => event.payload)).toEqual([
      { id: "step-a", status: "running", reason: "Picked up by the first writer", expectedRevision: 0 },
      { id: "step-a", status: "blocked", reason: "Second writer re-planned after losing the swap", expectedRevision: 1 },
    ]);
    // The losing handle re-folded the winner's event and then applied its own on top.
    expect(second.state.cognition!.steps[0]).toMatchObject({ status: "blocked", revision: 2 });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a claimed step whose instance was reconciled passes the running-instance invariant", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    await ledger.recordDispatch({ id: "inst-1", orderId: "step-a", mode: "implement", skills: [] });
    // The restart reconciles the in-flight attempt; the step is left behind as running with a claim on it.
    await ledger.reconcileRunningInstances("process restarted");
    expect(ledger.state.cognition?.instances?.[0]?.status).toBe("failed");
    const step = ledger.state.cognition!.steps.find(item => item.id === "step-a")!;
    step.status = "running";
    step.claimedBy = "inst-1";
    const codes = () => checkTaskInvariants(ledger.state).map(item => item.code);
    // The claim names an instance that exists and ended: no violation.
    expect(codes()).not.toContain("S/step-running-without-instance");
    // A claim naming an instance that never existed does not excuse the running step.
    step.claimedBy = "ghost";
    expect(codes()).toContain("S/step-running-without-instance");
    // Neither a live instance nor a claim: the violation stands.
    delete step.claimedBy;
    expect(codes()).toContain("S/step-running-without-instance");
    // Negative board revisions are their own I7 violation.
    step.revision = -1;
    expect(codes()).toContain("I7/step-revision-negative");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
