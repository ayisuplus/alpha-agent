import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingFromState, type AgentMessage } from "../src/runtime/agent-mailbox";
import { TaskLedger } from "../src/runtime/task-ledger";
import { summarizeTaskEvents } from "../src/runtime/task-event-summary";
import { readEvents, taskLogDir } from "../src/runtime/task-events";
import { reapOrphanWorkers } from "../src/runtime/operation-journal";
import { WorkerStopError, workerStopReason } from "../src/runtime/worker-stop";
import { WorkerSupervisor } from "../src/runtime/worker-supervisor";
import { executeWorkOrders, type WorkOrder } from "../src/runtime/work-orders";

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alpha-worker-lifecycle-"));
  const projectRoot = join(root, "project");
  const dataRoot = join(root, "data");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await git(projectRoot, "init");
  await git(projectRoot, "config", "user.email", "test@example.com");
  await git(projectRoot, "config", "user.name", "Test");
  await writeFile(join(projectRoot, "src", "first.txt"), "committed");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "base");
  const ledger = await TaskLedger.create(dataRoot, { objective: "Change one module", projectRoot, taskType: "code-change", criteria: [{ id: "change", description: "Change", kind: "asset" }] });
  return { root, projectRoot, dataRoot, ledger };
}

function order(id: string, path: string): WorkOrder {
  return { id, objective: `Change ${path}`, ownedPaths: [path], dependsOn: [], resources: [`module:${id}`], mode: "implement", instanceId: crypto.randomUUID() };
}

test("a subagent that submits no result leaves a no-result fact instead of a sentence", async () => {
  const state = await fixture();
  const supervisor = new WorkerSupervisor({
    ...state, remainingCalls: () => 1_000, remainingTimeMs: () => 1_000_000,
    runWorkers: input => executeWorkOrders({ ...input, async runWorker() { throw new WorkerStopError("no-result", "Worker did not submit alpha_worker_result for this run"); } }),
  });
  try {
    const [id] = await supervisor.spawn([order("first", "src/first.txt")]);
    await supervisor.wait([id], 10_000, false);

    const instance = state.ledger.state.cognition?.instances?.find(item => item.id === id);
    expect(instance?.status).toBe("failed");
    expect(instance?.stopReason).toBe("no-result");
    expect(instance?.findings?.[0]).toContain("did not submit alpha_worker_result");

    const rows = summarizeTaskEvents(await readEvents(taskLogDir(state.ledger.file)));
    const result = rows.find(row => row.type === "worker/result");
    expect(result?.label).toContain("未交结果");
    expect(result?.tone).toBe("danger");
    expect(result?.refs?.workerId).toBe(id);
    // The primary agent reads the reason from the log, not from the finding text.
    expect((await readEvents(taskLogDir(state.ledger.file))).some(event => event.type === "worker/result" && event.payload.stopReason === "no-result")).toBe(true);
  } finally {
    await supervisor.cancelAll();
    await rm(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("a hard kill leaves enough in the log to reap the orphan and keep undelivered messages", async () => {
  const state = await fixture();
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1_000, remainingTimeMs: () => 1_000_000, runWorkers: input => executeWorkOrders({ ...input, async runWorker(workOrder, _directory, signal) {
    await input.onWorkerEvent?.(workOrder, "started");
    const { promise, resolve } = Promise.withResolvers<void>();
    signal?.addEventListener("abort", () => resolve(), { once: true });
    await promise;
    throw new Error("aborted");
  } }) });
  let orphanPid = 0;
  try {
    const [id] = await supervisor.spawn([order("first", "src/first.txt")]);
    // What the supervisor records before the child writes anything: a live worker process we can find again.
    const sleeper = join(state.root, "run-worker.ts");
    await writeFile(sleeper, "await Bun.sleep(60_000);");
    const orphan = Bun.spawn([process.execPath, sleeper], { stdout: "ignore", stderr: "ignore" });
    orphanPid = orphan.pid;
    await state.ledger.recordWorkerActivation({
      attemptId: id, orderId: "first", pid: orphanPid,
      workRoot: join(state.dataRoot, "workers", state.ledger.state.id, id), worktreePath: join(state.dataRoot, "worker-agents", state.ledger.state.id, "agent-1", "project"),
    });
    const message: AgentMessage = {
      id: "message-1", taskId: state.ledger.state.id, fromAgentId: null, fromRunId: null, toAgentId: "agent-1",
      kind: "information", body: "Context for the worker", evidence: [], contractVersion: 1, baseRevision: null, recordedAt: new Date().toISOString(),
    };
    await state.ledger.recordWorkerMessage(message);

    const reaped = await reapOrphanWorkers(state.ledger);
    expect(reaped).toEqual([`first:${orphanPid}`]);
    // The reaped child exits on its own; waiting on the process beats guessing how long SIGTERM takes.
    await orphan.exited;
    let alive = true;
    try { process.kill(orphanPid, 0); } catch { alive = false; }
    expect(alive).toBe(false);

    // Recovery closes the attempt as no-result and leaves the message queued for whoever continues the agent.
    await state.ledger.reconcileRunningInstances("Interrupted operation was reconciled; inspect evidence before redispatch");
    const instance = state.ledger.state.cognition?.instances?.find(item => item.id === id);
    expect(instance?.status).toBe("failed");
    expect(instance?.stopReason).toBe("no-result");
    expect(pendingFromState(state.ledger.state, "agent-1").map(item => item.id)).toEqual(["message-1"]);
    expect(pendingFromState(state.ledger.state, null)).toEqual([]);

    await state.ledger.acknowledgeWorkerMessage("message-1", "agent-1");
    expect(pendingFromState(state.ledger.state, "agent-1")).toEqual([]);
  } finally {
    if (orphanPid) { try { process.kill(orphanPid, "SIGKILL"); } catch { /* already gone */ } }
    await supervisor.cancelAll();
    await rm(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("recovery never reaps a process that is not one of our workers", async () => {
  const state = await fixture();
  try {
    const bystander = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
    // Only a dispatched attempt can carry a pid: the log cannot claim processes for attempts that do not exist.
    await expect(state.ledger.recordWorkerActivation({ attemptId: "attempt-1", orderId: "first", pid: bystander.pid })).rejects.toThrow("Worker attempt not found");
    await state.ledger.recordDispatch({ id: "attempt-1", orderId: "coordinator", mode: "investigate", skills: [] });
    await state.ledger.recordWorkerActivation({ attemptId: "attempt-1", orderId: "coordinator", pid: bystander.pid, workRoot: join(state.dataRoot, "workers", "attempt-1") });
    expect(await reapOrphanWorkers(state.ledger)).toEqual([]);
    await bystander.exited;
  } finally {
    await rm(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("every way a worker can end maps to a stop reason", () => {
  expect(workerStopReason({ resultStopReason: "max-tokens" })).toBe("max-tokens");
  expect(workerStopReason({ resultStatus: "needs-context" })).toBe("needs-input");
  expect(workerStopReason({ cancelled: true, errorText: "Worker was cancelled or timed out" })).toBe("aborted");
  expect(workerStopReason({ timedOut: true, errorText: "Worker was cancelled or timed out" })).toBe("no-result");
  expect(workerStopReason({ errorText: "Worker did not submit alpha_worker_result for this run" })).toBe("no-result");
  expect(workerStopReason({ errorText: "Model produced no response within 45000 ms" })).toBe("error");
  expect(workerStopReason({ resultStatus: "completed" })).toBe("completed");
  expect(workerStopReason({ usageIncomplete: true })).toBe("no-result");
});
