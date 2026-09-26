import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../src/runtime/task-ledger";
import { WorkerSupervisor } from "../src/runtime/worker-supervisor";
import { executeWorkOrders, type WorkOrder } from "../src/runtime/work-orders";
import { checkFileToolCall } from "../src/runtime/file-tool-guard";
import { createWorkerResultTool } from "../src/runtime/worker-result-tool";

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alpha-async-workers-"));
  const projectRoot = join(root, "project");
  const dataRoot = join(root, "data");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await git(projectRoot, "init");
  await git(projectRoot, "config", "user.email", "test@example.com");
  await git(projectRoot, "config", "user.name", "Test");
  await writeFile(join(projectRoot, "src", "first.txt"), "committed");
  await writeFile(join(projectRoot, "src", "second.txt"), "second-old");
  await writeFile(join(projectRoot, "src", "third.txt"), "third-old");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "-m", "base");
  await writeFile(join(projectRoot, "src", "first.txt"), "dirty-parent");
  const ledger = await TaskLedger.create(dataRoot, { objective: "Change two modules", projectRoot, taskType: "code-change", criteria: [{ id: "change", description: "Change", kind: "asset" }] });
  return { root, projectRoot, dataRoot, ledger };
}

function order(id: string, path: string, dependsOn: string[] = [], readPaths: string[] = []): WorkOrder {
  return { id, objective: `Change ${path}`, ownedPaths: [path], readPaths, dependsOn, resources: [`module:${id}`], mode: "implement", instanceId: crypto.randomUUID() };
}

test("async Git workers inherit dirty source, keep parent edits, and integrate one by one", async () => {
  const state = await fixture();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const workerStarted = new Promise<void>(resolve => { started = resolve; });
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory) {
      await input.onWorkerEvent?.(workOrder, "started");
      expect(await git(directory, "rev-parse", "--is-inside-work-tree")).toBe("true");
      expect(await readFile(join(directory, "src", "first.txt"), "utf8")).toBe("dirty-parent");
      started(); await gate;
      await writeFile(join(directory, "src", "first.txt"), "worker-change");
      return { status: "completed", evidence: [], unresolved: [] };
    },
  }) });
  try {
    const [id] = await supervisor.spawn([order("first", "src/first.txt")]);
    await workerStarted;
    expect(() => supervisor.assertParentTool("alpha_inbox")).not.toThrow();
    expect(() => supervisor.assertParentTool("alpha_send")).not.toThrow();
    await expect(checkFileToolCall("write", { path: "src/first.txt" }, state.projectRoot, undefined, [], false, supervisor)).rejects.toThrow("reserved");
    await checkFileToolCall("write", { path: "src/second.txt" }, state.projectRoot, undefined, [], false, supervisor);
    await writeFile(join(state.projectRoot, "src", "second.txt"), "parent-change");
    release();
    const [ready] = await supervisor.wait([id], 10_000);
    expect(ready.instance.status).toBe("returned");
    expect(ready.instance.worktreePath).toContain(id);
    expect(ready.diff).toContain("worker-change");
    expect(await readFile(join(state.projectRoot, "src", "first.txt"), "utf8")).toBe("dirty-parent");
    expect((await supervisor.integrate(id)).status).toBe("merged");
    expect(await readFile(join(state.projectRoot, "src", "first.txt"), "utf8")).toBe("worker-change");
    expect(await readFile(join(state.projectRoot, "src", "second.txt"), "utf8")).toBe("parent-change");
    await expect(supervisor.integrate(id)).rejects.toThrow("not awaiting integration");
  } finally { release(); await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("dependency waits for integration, and changed read input blocks integration", async () => {
  const state = await fixture();
  const starts: string[] = [];
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory) {
      await input.onWorkerEvent?.(workOrder, "started");
      starts.push(workOrder.id);
      await writeFile(join(directory, workOrder.ownedPaths[0]), `${workOrder.id}-new`);
      return { status: "completed", evidence: [], unresolved: [] };
    },
  }) });
  try {
    const [firstId, secondId] = await supervisor.spawn([order("first", "src/first.txt", [], ["src/second.txt"]), order("second", "src/second.txt", ["first"])]);
    expect((await supervisor.wait([firstId], 10_000))[0].instance.status).toBe("returned");
    expect(starts).toEqual(["first"]);
    await writeFile(join(state.projectRoot, "src", "second.txt"), "external-change");
    await expect(supervisor.integrate(firstId)).rejects.toThrow("read dependency changed");
    expect(state.ledger.state.cognition?.instances?.find(item => item.id === firstId)?.integration).toBe("conflict");
    expect(starts).toEqual(["first"]);
    await supervisor.cancel(firstId);
    expect((await supervisor.wait([secondId], 5_000))[0].instance.status).toBe("blocked");
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("worker pool is bounded and cancelling one attempt keeps its sibling", async () => {
  const state = await fixture();
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory, signal) {
      await input.onWorkerEvent?.(workOrder, "started");
      started.push(workOrder.id);
      await Promise.race([new Promise<void>(resolve => releases.set(workOrder.id, resolve)), new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      signal?.throwIfAborted();
      await writeFile(join(directory, workOrder.ownedPaths[0]), `${workOrder.id}-new`);
      return { status: "completed", evidence: [], unresolved: [] };
    },
  }) });
  try {
    const [firstId, secondId, thirdId] = await supervisor.spawn([order("first", "src/first.txt"), order("second", "src/second.txt"), order("third", "src/third.txt")]);
    for (let i = 0; i < 100 && started.length < 2; i++) await Bun.sleep(10);
    expect(started.sort()).toEqual(["first", "second"]);
    expect((await supervisor.inspect(thirdId)).instance.status).toBe("queued");
    await supervisor.cancel(firstId);
    expect((await supervisor.wait([firstId], 10_000))[0].instance.status).toBe("cancelled");
    for (let i = 0; i < 100 && !started.includes("third"); i++) await Bun.sleep(10);
    expect(started).toContain("third");
    expect((await supervisor.inspect(secondId)).instance.status).toBe("running");
    releases.get("second")?.(); releases.get("third")?.();
    expect((await supervisor.wait([secondId, thirdId], 10_000)).map(item => item.instance.status)).toEqual(["returned", "returned"]);
  } finally { for (const release of releases.values()) release(); await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("insufficient shared budget starts no worker", async () => {
  const state = await fixture();
  try {
    const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 39 });
    await expect(supervisor.spawn([order("first", "src/first.txt")])).rejects.toThrow("budget");
    expect(state.ledger.state.cognition?.instances ?? []).toHaveLength(0);
  } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("review-mode worktree worker cannot integrate source edits even with full access", async () => {
  const state = await fixture();
  const child = { ...order("reviewer", "src/first.txt"), mode: "review" as const, fullAccess: true };
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory) {
      await input.onWorkerEvent?.(workOrder, "started");
      await checkFileToolCall("read", { path: "src/second.txt" }, directory, workOrder);
      await checkFileToolCall("write", { path: "src/second.txt" }, directory, workOrder);
      await writeFile(join(directory, "src", "second.txt"), "reviewer-fix");
      return { status: "completed", reviewVerdict: "pass", evidence: [], unresolved: [] };
    },
  }) });
  try {
    const [id] = await supervisor.spawn([child]);
    expect((await supervisor.wait([id], 10_000))[0].instance.status).toBe("failed");
    await expect(supervisor.integrate(id)).rejects.toThrow("not awaiting integration");
    expect(await readFile(join(state.projectRoot, "src", "second.txt"), "utf8")).not.toBe("reviewer-fix");
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("an observed read outside path hints still invalidates stale work", async () => {
  const state = await fixture();
  const child = { ...order("reader", "src/first.txt"), fullAccess: true };
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory) {
      await input.onWorkerEvent?.(workOrder, "started");
      const observed = new Set<string>();
      await checkFileToolCall("read", { path: "src/second.txt" }, directory, workOrder, [], false, undefined, path => observed.add(path));
      await writeFile(join(directory, "src", "first.txt"), "worker-fix");
      return { status: "completed", readPaths: [...observed], evidence: [], unresolved: [] };
    },
  }) });
  try {
    const [id] = await supervisor.spawn([child]);
    expect((await supervisor.wait([id], 10_000))[0].instance.status).toBe("returned");
    await writeFile(join(state.projectRoot, "src", "second.txt"), "parent-update");
    await expect(supervisor.integrate(id)).rejects.toThrow("read dependency changed");
    expect(await readFile(join(state.projectRoot, "src", "first.txt"), "utf8")).toBe("dirty-parent");
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("configured checks do not create a whole-project read dependency", async () => {
  const state = await fixture();
  const observed: string[] = [];
  const child = { ...order("checker", "src/first.txt"), fullAccess: true };
  try {
    await checkFileToolCall("alpha_check", { script: "test" }, state.projectRoot, child, [], false, undefined, path => observed.push(path));
    expect(observed).toEqual([]);
    await checkFileToolCall("alpha_command", { argv: ["git", "status", "--short"] }, state.projectRoot, child, [], false, undefined, path => observed.push(path));
    expect(observed).toEqual(["."]);
  } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("a worker approval request pauses the parent task instead of reporting a generic failure", async () => {
  const state = await fixture();
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder) {
      await input.onWorkerEvent?.(workOrder, "started");
      return { status: "needs-context", findings: ["Command approval required"], evidence: [], unresolved: ["Command approval required"] };
    },
  }) });
  try {
    const [id] = await supervisor.spawn([order("approval", "src/first.txt")]);
    expect((await supervisor.wait([id], 10_000))[0].instance.status).toBe("blocked");
    expect(state.ledger.state.status).toBe("needs-input");
    expect(state.ledger.state.pendingQuestion).toContain("Command approval required");
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("integration requires a reviewed result and rejects a worktree changed afterward", async () => {
  const state = await fixture();
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory) {
      await input.onWorkerEvent?.(workOrder, "started");
      await writeFile(join(directory, "src", "first.txt"), "original-worker-output");
      return { status: "completed", evidence: [], unresolved: [] };
    },
  }) });
  try {
    const [id] = await supervisor.spawn([order("integrity", "src/first.txt")]);
    for (let i = 0; i < 100 && state.ledger.state.cognition?.instances?.find(item => item.id === id)?.status !== "returned"; i++) await Bun.sleep(10);
    await expect(supervisor.integrate(id)).rejects.toThrow("Inspect the worker result");
    const [review] = await supervisor.wait([id], 0);
    expect(review.diff).toContain("original-worker-output");
    await writeFile(join(review.instance.worktreePath!, "src", "first.txt"), "changed-after-review");
    await expect(supervisor.integrate(id)).rejects.toThrow("changed after inspection");
    expect(await readFile(join(state.projectRoot, "src", "first.txt"), "utf8")).toBe("dirty-parent");
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("full-capability reviewer must cite current source before passing", async () => {
  const state = await fixture();
  try {
    const excerpt = "This source excerpt is long enough for a review.";
    await writeFile(join(state.projectRoot, "src", "first.txt"), excerpt);
    const tool = createWorkerResultTool(state.ledger, { ...order("review", "src/first.txt"), mode: "review", fullAccess: true });
    const missing = await tool.execute("missing", { status: "completed", findings: [], reviewVerdict: "pass" }, undefined as never, undefined as never);
    expect(missing.isError).toBe(true);
    const accepted = await tool.execute("accepted", { status: "completed", findings: [], reviewVerdict: "pass", reviewEvidence: [{ path: "src/first.txt", excerpt }] }, undefined as never, undefined as never);
    expect(accepted.isError).toBeUndefined();
    expect(state.ledger.state.workerOutcome?.reviewEvidence?.[0]?.excerpt).toBe(excerpt);
  } finally { await rm(state.root, { recursive: true, force: true }); }
});

test("cancelling during worker preparation prevents launch and releases its budget once", async () => {
  const state = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.ledger.refreshRevision = async () => { entered(); await gate; return false; };
  let launches = 0;
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: async () => { launches++; throw new Error("Worker should not launch"); } });
  try {
    const [id] = await supervisor.spawn([order("early-cancel", "src/first.txt")]);
    await preparing;
    const cancellation = supervisor.cancel(id);
    release();
    await cancellation;
    expect(launches).toBe(0);
    expect(state.ledger.state.cognition?.instances?.find(item => item.id === id)?.status).toBe("cancelled");
    expect(supervisor.reservations).toBe(0);
    expect(supervisor.timeReservations).toBe(0);
  } finally { release(); await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("a no-change review cannot integrate after its read dependency changes", async () => {
  const state = await fixture();
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder) {
      await input.onWorkerEvent?.(workOrder, "started");
      return { status: "completed", evidence: [], unresolved: [], reviewVerdict: "pass", reviewEvidence: [{ path: "src/first.txt", excerpt: "dirty-parent" }] };
    },
  }) });
  try {
    const reviewOrder = { ...order("final-review", "src/first.txt", [], ["."]), mode: "review" as const, fullAccess: true, resources: ["final-review"] };
    const [id] = await supervisor.spawn([reviewOrder]);
    expect((await supervisor.wait([id], 10_000))[0].instance.status).toBe("returned");
    await writeFile(join(state.projectRoot, "src", "second.txt"), "changed after review");
    await expect(supervisor.integrate(id)).rejects.toThrow("read dependency changed");
    expect(state.ledger.state.cognition?.instances?.find(item => item.id === id)?.status).toBe("returned");
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("a dependent worker follows the latest retry of its prerequisite", async () => {
  const state = await fixture();
  let firstFailed = false;
  const started: string[] = [];
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory) {
      await input.onWorkerEvent?.(workOrder, "started");
      if (workOrder.id === "first" && !firstFailed) { firstFailed = true; throw new Error("First attempt failed"); }
      started.push(workOrder.id);
      await writeFile(join(directory, workOrder.ownedPaths[0]), `${workOrder.id}-done`);
      return { status: "completed", evidence: [], unresolved: [] };
    },
  }) });
  try {
    const [failedId] = await supervisor.spawn([order("first", "src/first.txt")]);
    expect((await supervisor.wait([failedId], 10_000))[0].instance.status).toBe("failed");
    const [retryId, dependentId] = await supervisor.spawn([order("first", "src/first.txt"), order("second", "src/second.txt", ["first"])]);
    expect((await supervisor.wait([retryId], 10_000))[0].instance.status).toBe("returned");
    expect(state.ledger.state.cognition?.instances?.find(item => item.id === dependentId)?.status).toBe("queued");
    await supervisor.integrate(retryId);
    expect((await supervisor.wait([dependentId], 10_000))[0].instance.status).toBe("returned");
    expect(started).toEqual(["first", "second"]);
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});

test("worker dispatch fails clearly when the assigned project is not a Git root", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-no-git-"));
  try {
    const projectRoot = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "entry.txt"), "source");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Edit source", projectRoot, taskType: "code-change", workspaceOrigin: { kind: "direct" }, criteria: [{ id: "change", description: "Change", kind: "asset" }] });
    const supervisor = new WorkerSupervisor({ ledger, dataRoot, remainingCalls: () => 1000 });
    await expect(supervisor.spawn([order("change", "entry.txt")])).rejects.toThrow("Git project root");
    expect(ledger.state.cognition?.instances ?? []).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed projects without Git gain an empty local anchor for isolated workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-managed-no-git-"));
  try {
    const projectRoot = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "entry.txt"), "initial");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Edit source", projectRoot, taskType: "code-change", criteria: [{ id: "change", description: "Change", kind: "asset" }] });
    const supervisor = new WorkerSupervisor({ ledger, dataRoot, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
      async runWorker(workOrder, directory) {
        await input.onWorkerEvent?.(workOrder, "started");
        await writeFile(join(directory, "entry.txt"), "worker-change");
        return { status: "completed", evidence: [], unresolved: [] };
      },
    }) });
    const [id] = await supervisor.spawn([order("change", "entry.txt")]);
    expect(await git(projectRoot, "rev-parse", "--verify", "HEAD")).toHaveLength(40);
    expect((await supervisor.wait([id], 10_000))[0].instance.status).toBe("returned");
    expect((await supervisor.integrate(id)).status).toBe("merged");
    expect(await readFile(join(projectRoot, "entry.txt"), "utf8")).toBe("worker-change");
    await supervisor.cancelAll();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persistent subagent continues in its worktree and merges cumulative changes", async () => {
  const state = await fixture();
  const agentId = crypto.randomUUID();
  const preset = { id: "test-expert", name: "Test expert", description: "Test", instructions: "Test", hash: "a".repeat(64), skillIds: ["test:skill"], package: { revision: "b".repeat(64), skills: [{ id: "test:skill", hash: "c".repeat(64) }] } };
  const work = { ...order("persistent", "src/first.txt"), fullAccess: true, agentId, preset, skillIds: ["test:skill"] };
  let runs = 0;
  const supervisor = new WorkerSupervisor({ ...state, remainingCalls: () => 1000, runWorkers: input => executeWorkOrders({ ...input,
    async runWorker(workOrder, directory) {
      await input.onWorkerEvent?.(workOrder, "started");
      runs++;
      expect(directory).toBe(join(state.dataRoot, "worker-agents", state.ledger.state.id, agentId, "project"));
      expect(await readFile(join(directory, "src", "first.txt"), "utf8")).toBe(runs === 1 ? "dirty-parent" : runs === 2 ? "first-run" : "second-run");
      if (workOrder.mode === "implement") await writeFile(join(directory, "src", "first.txt"), runs === 1 ? "first-run" : "second-run");
      return { status: "completed", findings: [`run ${runs}`], evidence: [], unresolved: [], ...(workOrder.mode === "review" ? { reviewVerdict: "pass" as const } : {}), cognition: { revision: runs, understanding: `run ${runs}`, findings: [], openQuestions: [], nextActions: [], sourceRevision: null } };
    },
  }) });
  try {
    const [first] = await supervisor.spawn([work]);
    expect((await supervisor.wait([first], 10_000))[0].instance.status).toBe("returned");
    await expect(supervisor.continue(agentId, "Review before integration", "review")).rejects.toThrow("Integrate or discard");
    const second = await supervisor.continue(agentId, "Finish the change");
    const result = (await supervisor.wait([second], 10_000))[0];
    expect(result.instance.status).toBe("returned");
    expect(result.diff).toContain("second-run");
    expect(result.diff).toContain("dirty-parent");
    expect(state.ledger.state.cognition?.agents?.[0].cognition?.understanding).toBe("run 2");
    expect((await supervisor.integrate(second)).status).toBe("merged");
    expect(await readFile(join(state.projectRoot, "src", "first.txt"), "utf8")).toBe("second-run");
    const third = await supervisor.continue(agentId, "Check the integrated source", "review");
    expect((await supervisor.wait([third], 10_000))[0].instance.status).toBe("returned");
    expect((await supervisor.integrate(third)).status).toBe("merged");
    expect(state.ledger.state.cognition?.instances?.map(item => item.agentId)).toEqual([agentId, agentId, agentId]);
  } finally { await supervisor.cancelAll(); await rm(state.root, { recursive: true, force: true }); }
});
