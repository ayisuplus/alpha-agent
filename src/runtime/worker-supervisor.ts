import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { runModelWorkOrders } from "./model-workers";
import { integratePreparedWorkOrder, validateOrders, type WorkBatchReport, type WorkOrder } from "./work-orders";
import type { TaskLedger } from "./task-ledger";
import type { BrowserSession } from "./visible-browser";

async function ensureWorktreeBase(projectRoot: string, managed: boolean): Promise<void> {
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", projectRoot, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { output: output.trim(), error: error.trim(), code };
  };
  let top = await git("rev-parse", "--show-toplevel");
  const expected = resolve(projectRoot);
  const atRoot = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() === expected.toLowerCase() : resolve(value) === expected;
  if (managed && (top.code !== 0 || !atRoot(top.output))) {
    const init = await git("init");
    if (init.code !== 0) throw new Error(`Cannot initialize managed Git workspace: ${init.error}`);
    top = await git("rev-parse", "--show-toplevel");
  }
  if (top.code !== 0 || !atRoot(top.output)) throw new Error("Parallel workers require a Git project root");
  if ((await git("rev-parse", "--verify", "HEAD")).code !== 0) {
    if (!managed) throw new Error("Parallel workers require an existing HEAD commit");
    const anchor = await git("-c", "user.name=Alpha", "-c", "user.email=alpha@local", "commit", "--allow-empty", "-m", "Alpha worktree anchor");
    if (anchor.code !== 0) throw new Error(`Cannot create managed Git worktree anchor: ${anchor.error}`);
  }
}

type Attempt = { order: WorkOrder; controller: AbortController; promise?: Promise<void>; settling?: Promise<void>; inspected?: boolean; reserved?: boolean };
const liveSupervisors = new Map<string, WorkerSupervisor>();

export async function inspectWorkerAttempt(ledger: TaskLedger, dataRoot: string, id: string) {
  const instance = ledger.state.cognition?.instances?.find(item => item.id === id);
  if (!instance?.order) throw new Error("Worker attempt not found");
  const workRoot = join(dataRoot, "workers", ledger.state.id, id);
  const report = await readFile(join(workRoot, "merge.json"), "utf8").then(text => JSON.parse(text) as WorkBatchReport).catch(() => undefined);
  const eventText = await readFile(join(dataRoot, "worker-runs", ledger.state.id, id, "events.jsonl"), "utf8").catch(() => "");
  const events = eventText.split("\n").filter(Boolean).slice(-100).flatMap(line => {
    try { const item = JSON.parse(line) as { taskId: string; instanceId: string; orderId: string; sequence: number; type: string; value: string }; return item.taskId === ledger.state.id && item.instanceId === id && item.orderId === instance.orderId ? [{ ...item, value: String(item.value).slice(0, 500) }] : []; }
    catch { return []; }
  });
  let diff = "";
  for (const file of (report?.changes[instance.orderId] ?? []).slice(0, 20)) {
    if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid worker diff path");
    const before = await readFile(join(workRoot, "base", file), "utf8").catch(() => "");
    const after = await readFile(join(workRoot, instance.orderId, file), "utf8").catch(() => "");
    diff += createTwoFilesPatch(`before/${file}`, `after/${file}`, before, after).slice(0, 6_000);
    if (diff.length > 48_000) { diff = diff.slice(0, 48_000); break; }
  }
  return { instance, events, ...(report ? { report, diff } : {}) };
}

/** One supervisor owns child processes and all writes to its parent task ledger. */
export class WorkerSupervisor {
  private readonly attempts = new Map<string, Attempt>();
  private readonly active = new Set<string>();
  private maxParallel = 2;
  private reservedCalls = 0;
  private reservedTimeMs = 0;
  private browserOwner: string | null = null;
  private integration: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly input: {
    ledger: TaskLedger; dataRoot: string; parentId?: string; modelSelector?: string; signal?: AbortSignal;
    plugins?: { comfyui: boolean }; generation?: { image: boolean; voice: boolean; video: boolean }; comfyUrl?: string;
    browser?: BrowserSession; browserUrl?: string; browserAccess?: () => boolean;
    remainingCalls: () => number; remainingTimeMs?: () => number; onStatus?: (message: string) => void; onChange?: () => void; runWorkers?: typeof runModelWorkOrders;
  }) {
    liveSupervisors.set(input.ledger.state.id, this);
    for (const instance of input.ledger.state.cognition?.instances ?? []) {
      if (instance.status === "returned" && instance.order) this.attempts.set(instance.id, { order: instance.order, controller: new AbortController() });
    }
    input.signal?.addEventListener("abort", () => { void this.cancelAll(); }, { once: true });
  }

  get ledger() { return this.input.ledger; }
  static forTask(taskId: string) { return liveSupervisors.get(taskId); }
  get reservations() { return this.reservedCalls; }
  get timeReservations() { return this.reservedTimeMs; }
  get unsettled() { return [...this.attempts.keys()].some(id => ["queued", "running", "returned"].includes(this.instance(id)?.status ?? "")); }
  get running() { return this.active.size > 0; }
  get needsIntegration() { return [...this.attempts.keys()].some(id => this.instance(id)?.status === "returned"); }
  private instance(id: string) { return this.ledger.state.cognition?.instances?.find(item => item.id === id); }
  private releaseReservation(attempt: Attempt): void {
    if (!attempt.reserved) return;
    attempt.reserved = false;
    this.reservedCalls -= 40;
    this.reservedTimeMs -= 120_000;
  }
  private notify() { this.input.onChange?.(); for (const listener of this.listeners) listener(); if (!this.unsettled && liveSupervisors.get(this.ledger.state.id) === this) liveSupervisors.delete(this.ledger.state.id); }

  claimBrowser(id: string): boolean {
    if (this.input.browserAccess?.() === false) { this.browserOwner = null; return false; }
    if (this.browserOwner && this.browserOwner !== id) return false;
    this.browserOwner = id;
    return true;
  }
  releaseBrowser(id: string) { if (this.browserOwner === id) this.browserOwner = null; }

  assertParentWrite(path: string): void {
    const target = path.toLowerCase();
    for (const [id, attempt] of this.attempts) {
      if (!["queued", "running", "returned"].includes(this.instance(id)?.status ?? "")) continue;
      if ([...attempt.order.ownedPaths, ...(attempt.order.readPaths ?? [])].some(scope => scope === "." || (scope.endsWith("/") ? target.startsWith(scope.toLowerCase()) : target === scope.toLowerCase()))) throw new Error(`Path is reserved by worker ${id}: ${path}`);
    }
  }
  assertParentTool(name: string): void {
    if (!this.unsettled) return;
    if (!["read", "grep", "edit", "write", "alpha_spawn", "alpha_inspect", "alpha_wait", "alpha_cancel", "alpha_integrate", "alpha_browser", "alpha_plan", "alpha_step", "alpha_gap", "alpha_gap_resolve", "alpha_expert_search", "alpha_search", "alpha_crawl", "alpha_site", "alpha_source"].includes(name)) throw new Error(`Wait for worker integration before using ${name}`);
  }

  async spawn(orders: WorkOrder[], maxParallel = this.maxParallel): Promise<string[]> {
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 4) throw new Error("Worker concurrency must be 1–4");
    const outstanding = [...this.attempts.entries()].filter(([id]) => ["queued", "running", "returned"].includes(this.instance(id)?.status ?? "")).map(([, value]) => value.order);
    validateOrders([...outstanding, ...orders], 16);
    const ids = new Set(orders.map(order => order.id));
    for (const order of orders) for (const dep of order.dependsOn ?? []) {
      if (!ids.has(dep) && this.ledger.state.cognition?.steps.find(step => step.id === dep)?.status !== "complete") throw new Error(`Unknown or incomplete dependency: ${order.id} -> ${dep}`);
    }
    if (this.input.remainingCalls() - this.reservedCalls < orders.length * 40) throw new Error("Task-wide tool budget cannot reserve these workers");
    if (this.input.remainingTimeMs && this.input.remainingTimeMs() - this.reservedTimeMs < orders.length * 120_000) throw new Error("Task-wide time budget cannot reserve these workers");
    await ensureWorktreeBase(this.ledger.state.projectRoot, ["generated", "copy"].includes(this.ledger.state.workspaceOrigin?.kind ?? ""));
    this.maxParallel = maxParallel;
    liveSupervisors.set(this.ledger.state.id, this);
    this.releaseBrowser("coordinator");
    const assigned: string[] = [];
    for (const order of orders) {
      const id = order.instanceId!;
      if (!id) throw new Error("Worker instance ID is required");
      await this.ledger.queueWorker({ id, parentId: this.input.parentId, order, expert: order.preset ? { id: order.preset.id, name: order.preset.name, hash: order.preset.hash } : undefined });
      this.attempts.set(id, { order, controller: new AbortController(), reserved: true });
      assigned.push(id);
      this.reservedCalls += 40;
      this.reservedTimeMs += 120_000;
    }
    this.pump();
    this.notify();
    return assigned;
  }

  private pump(): void {
    for (const [id, attempt] of this.attempts) {
      if (this.active.size >= this.maxParallel) break;
      if (attempt.settling) continue;
      if (this.instance(id)?.status !== "queued") continue;
      const dependencies = attempt.order.dependsOn ?? [];
      const states = dependencies.map(dep => {
        const attempt = [...this.attempts.entries()].findLast(([, value]) => value.order.id === dep);
        if (attempt) return this.instance(attempt[0])?.status === "completed" ? "complete" : ["failed", "blocked", "cancelled"].includes(this.instance(attempt[0])?.status ?? "") ? "blocked" : "running";
        return this.ledger.state.cognition?.steps.find(step => step.id === dep)?.status;
      });
      if (states.some(state => state === "blocked" || state === "cancelled")) {
        attempt.settling = this.ledger.updateWorker(id, "blocked", { findings: ["Dependency did not complete"] }).then(() => { this.releaseReservation(attempt); this.notify(); });
        continue;
      }
      if (states.some(state => state !== "complete")) continue;
      this.active.add(id);
      attempt.promise = this.execute(id, attempt).finally(() => { this.active.delete(id); this.pump(); this.notify(); });
    }
  }

  private async execute(id: string, attempt: Attempt): Promise<void> {
    const { ledger, dataRoot, modelSelector, browser, browserUrl, browserAccess, plugins, generation, comfyUrl } = this.input;
    const manager = this;
    const signal = this.input.signal ? AbortSignal.any([this.input.signal, attempt.controller.signal]) : attempt.controller.signal;
    try {
      signal.throwIfAborted();
      await ledger.refreshRevision();
      signal.throwIfAborted();
      const report = await (this.input.runWorkers ?? runModelWorkOrders)({
        projectRoot: ledger.state.projectRoot, dataRoot, taskId: ledger.state.id, baseRevision: ledger.state.revision!,
        orders: [attempt.order], batchId: id, deferMerge: true, isolate: "git-worktree", signal, modelSelector, browser, browserUrl, browserAccess, plugins, generation, comfyUrl,
        workerContext: { taskType: ledger.state.taskType, workspaceOrigin: ledger.state.workspaceOrigin, capabilities: ledger.state.capabilities, permissionMode: ledger.state.permissionMode },
        browserLease: { claim: worker => this.claimBrowser(worker), release: worker => this.releaseBrowser(worker) },
        async onWorkerEvent(order, state) {
          if (state === "started") { await ledger.updateWorker(id, "running", { skills: order.skillSnapshots ?? [] }); manager.notify(); }
        },
        async onWorkerUsage(order, usage) {
          await ledger.recordRun({ model: usage.model, stage: "worker", instanceId: id, toolCalls: usage.incomplete ? 40 : usage.toolCalls, maxToolCalls: 40, wallTimeMs: 120_000, elapsedMs: usage.incomplete ? 120_000 : usage.elapsedMs, childElapsedMs: usage.elapsedMs, usageIncomplete: usage.incomplete, usage: usage.tokens, outcome: usage.outcome ?? "returned" });
        },
      });
      if (signal.aborted) throw new Error("Worker cancelled");
      const outcome = report.results[attempt.order.id];
      if (outcome?.status === "needs-context") {
        const reason = outcome.findings?.join("; ") || report.reason || "Worker needs task input";
        await ledger.updateWorker(id, "blocked", { workRoot: report.workRoot, findings: [reason] });
        if (ledger.state.status === "active") await ledger.needInput(reason, "worker-approval");
        this.input.onStatus?.(`子实例 ${attempt.order.id} 等待任务授权或输入`);
        return;
      }
      if (report.status !== "ready") throw new Error(report.reason ?? "Worker result was rejected");
      await ledger.updateWorker(id, "returned", { workRoot: report.workRoot, worktreePath: join(report.workRoot, attempt.order.id), integration: "pending", findings: report.results[attempt.order.id]?.findings ?? [] });
      this.input.onStatus?.(`子实例 ${attempt.order.id} 已返回，等待检查和集成`);
    } catch (error) {
      await ledger.updateWorker(id, signal.aborted ? "cancelled" : "failed", { findings: [error instanceof Error ? error.message : String(error)] });
      this.input.onStatus?.(`子实例 ${attempt.order.id} ${signal.aborted ? "已取消" : "失败"}`);
    } finally {
      this.releaseReservation(attempt);
      this.releaseBrowser(id);
      this.notify();
    }
  }

  async inspect(id: string) {
    const result = await inspectWorkerAttempt(this.ledger, this.input.dataRoot, id);
    if (result.instance.status === "returned" && result.report?.status === "ready") {
      const attempt = this.attempts.get(id);
      if (attempt) attempt.inspected = true;
    }
    return result;
  }

  async wait(ids: string[], timeoutMs = 30_000, presented = true): Promise<Array<Awaited<ReturnType<WorkerSupervisor["inspect"]>>>> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error("Wait must be 0–60000 ms");
    for (const id of ids) if (!this.instance(id)?.order) throw new Error(`Worker attempt not found: ${id}`);
    this.releaseBrowser("coordinator");
    if (timeoutMs && ids.every(id => ["queued", "running"].includes(this.instance(id)?.status ?? ""))) {
      await new Promise<void>(resolve => {
        const done = () => { if (ids.some(id => !["queued", "running"].includes(this.instance(id)?.status ?? ""))) { clearTimeout(timer); this.listeners.delete(done); resolve(); } };
        const timer = setTimeout(() => { this.listeners.delete(done); resolve(); }, timeoutMs);
        this.listeners.add(done);
        done();
      });
    }
    return Promise.all(ids.map(id => presented ? this.inspect(id) : inspectWorkerAttempt(this.ledger, this.input.dataRoot, id)));
  }

  async integrate(id: string): Promise<WorkBatchReport | { status: "accepted" }> {
    const attempt = this.attempts.get(id);
    if (!attempt || this.instance(id)?.status !== "returned") throw new Error("Worker attempt is not awaiting integration");
    if (!attempt.inspected) throw new Error("Inspect the worker result and diff before integration");
    const action = this.integration.then(async () => {
      if (this.instance(id)?.status !== "returned") throw new Error("Worker attempt is no longer awaiting integration");
      const result = await this.inspect(id);
      if (result.report?.status !== "ready") throw new Error("Worker output is not ready");
      const report = await integratePreparedWorkOrder(this.ledger.state.projectRoot, this.input.dataRoot, this.ledger.state.id, id, attempt.order, this.input.signal);
      if (report.status !== "merged") throw new Error(report.reason ?? "Integration failed");
      await this.ledger.refreshRevision();
      await this.ledger.updateWorker(id, "completed", { integration: "merged" });
      this.pump(); this.notify();
      return report;
    });
    this.integration = action.catch(() => undefined);
    try { return await action; }
    catch (error) { await this.ledger.updateWorker(id, "returned", { integration: "conflict", findings: [error instanceof Error ? error.message : String(error)] }); throw error; }
  }

  async cancel(id: string): Promise<void> {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new Error("Worker attempt not found");
    const state = this.instance(id)?.status;
    if (state === "returned") { await this.integration; if (this.instance(id)?.status !== "returned") throw new Error("Worker result was already integrated"); }
    if (state === "queued" && this.active.has(id)) {
      attempt.controller.abort(new Error("Worker cancelled"));
      await attempt.promise;
    } else if (state === "queued" || state === "returned") {
      await this.ledger.updateWorker(id, "cancelled", { findings: ["Cancelled by coordinator"] });
      if (state === "queued") this.releaseReservation(attempt);
      this.pump(); this.notify();
    } else if (state === "running") attempt.controller.abort(new Error("Worker cancelled"));
  }
  async cancelAll(): Promise<void> {
    for (const id of this.attempts.keys()) if (["queued", "running", "returned"].includes(this.instance(id)?.status ?? "")) await this.cancel(id);
    await Promise.allSettled([...this.attempts.values()].flatMap(item => [item.promise, item.settling].filter((promise): promise is Promise<void> => !!promise)));
  }
  async cancelExecuting(): Promise<void> {
    for (const id of this.attempts.keys()) if (["queued", "running"].includes(this.instance(id)?.status ?? "")) await this.cancel(id);
    await Promise.allSettled([...this.attempts.values()].flatMap(item => [item.promise, item.settling].filter((promise): promise is Promise<void> => !!promise)));
  }
}
