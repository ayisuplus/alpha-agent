import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { runModelWorkOrders } from "./model-workers";
import { integratePreparedWorkOrder, orderExpert, orderKind, prepareAgentWorkspace, validateOrders, type WorkBatchReport, type WorkOrder } from "./work-orders";
import { randomUUID } from "node:crypto";
import { fingerprintSource, type PlanNodeKind, type TaskLedger } from "./task-ledger";
import type { BrowserSession } from "./visible-browser";
import { AgentMailbox } from "./agent-mailbox";
import { SettingsStore } from "./settings";
import { stripReadSelector } from "./file-tool-guard";
import { ROLE_THINKING_POLICY_VERSION } from "./role-thinking";
import { capabilityPool } from "./capability-pool";
import { commandApprovalStore } from "./command-approval";
import { MCPPermissionStore } from "./mcp-permissions";
import { WorkerStopError, workerStopReason } from "./worker-stop";
import type { WorkerStopReason } from "./task-events";

const workerToolCalls = 80;
const workerWallTimeMs = 600_000; // The supervisor budget; model-workers kills the subprocess at +10s so a finished result can still be written.
/** Settings keep their historical per-mode keys; node kinds map onto them (§7 兼容). */
const WORKER_MODEL_KEY: Record<PlanNodeKind, "investigate" | "implement" | "review"> = { investigate: "investigate", execute: "implement", review: "review" };

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

type Attempt = { order: WorkOrder; controller: AbortController; promise?: Promise<void>; settling?: Promise<void>; inspected?: boolean; reserved?: boolean; cancelReason?: string };
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
  readonly mailbox: AgentMailbox;
  private messagePoll?: ReturnType<typeof setInterval>;
  private coordinatorSteer?: (text: string) => Promise<void>;
  private messageNotified = false;

  constructor(private readonly input: {
    ledger: TaskLedger; dataRoot: string; parentId?: string; modelSelector?: string; signal?: AbortSignal;
    plugins?: { comfyui: boolean }; generation?: { image: boolean; voice: boolean; video: boolean }; comfyUrl?: string;
    browser?: BrowserSession; browserUrl?: string; browserAccess?: () => boolean;
    remainingCalls: () => number; remainingTimeMs?: () => number; onStatus?: (message: string) => void; onChange?: () => void; runWorkers?: typeof runModelWorkOrders;
  }) {
    this.mailbox = new AgentMailbox(input.dataRoot, input.ledger);
    liveSupervisors.set(input.ledger.state.id, this);
    for (const instance of input.ledger.state.cognition?.instances ?? []) {
      if (instance.status === "returned" && instance.order) this.attempts.set(instance.id, { order: instance.order, controller: new AbortController() });
    }
    input.signal?.addEventListener("abort", () => { void this.cancelAll(); }, { once: true });
    this.startMessagePoll();
  }

  get ledger() { return this.input.ledger; }
  static forTask(taskId: string) { return liveSupervisors.get(taskId); }
  get reservations() { return this.reservedCalls; }
  get timeReservations() { return this.reservedTimeMs; }
  get unsettled() { return [...this.attempts.keys()].some(id => ["queued", "running", "returned"].includes(this.instance(id)?.status ?? "")); }
  get running() { return this.active.size > 0; }
  get needsIntegration() { return [...this.attempts.keys()].some(id => this.instance(id)?.status === "returned"); }
  get hasMessages() { return this.mailbox.pending; }
  setCoordinatorSteer(steer?: (text: string) => Promise<void>) {
    this.coordinatorSteer = steer;
    this.messageNotified = false;
    if (steer) void this.pollMessages();
  }
  private startMessagePoll() {
    if (this.messagePoll) return;
    this.messagePoll = setInterval(() => { void this.pollMessages().catch(error => this.input.onStatus?.(`子代理消息箱错误：${error instanceof Error ? error.message : String(error)}`)); }, 150);
    this.messagePoll.unref?.();
  }
  private async pollMessages() {
    await this.mailbox.collect();
    if (!this.mailbox.pending) { this.messageNotified = false; if (!this.unsettled) this.notify(); return; }
    if (this.messageNotified) return;
    this.messageNotified = true;
    this.notify();
    if (this.coordinatorSteer) await this.coordinatorSteer("Subagent inbox has unread messages. Use alpha_inbox to inspect them and decide whether to answer, forward, continue an agent, or request user input.").catch(() => undefined);
  }
  private instance(id: string) { return this.ledger.state.cognition?.instances?.find(item => item.id === id); }
  private releaseReservation(attempt: Attempt): void {
    if (!attempt.reserved) return;
    attempt.reserved = false;
    this.reservedCalls -= workerToolCalls;
    this.reservedTimeMs -= workerWallTimeMs;
  }
  private notify() {
    this.input.onChange?.();
    for (const listener of this.listeners) listener();
    if (!this.unsettled && !this.mailbox.pending) {
      if (liveSupervisors.get(this.ledger.state.id) === this) liveSupervisors.delete(this.ledger.state.id);
      if (this.messagePoll) { clearInterval(this.messagePoll); this.messagePoll = undefined; }
    }
  }

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
    if (!["read", "grep", "ast_grep", "lsp", "edit", "write", "alpha_spawn", "alpha_continue", "alpha_worker_resolve", "alpha_capability_search", "alpha_capability_mcp", "alpha_inspect", "alpha_wait", "alpha_cancel", "alpha_integrate", "alpha_send", "alpha_inbox", "alpha_browser", "alpha_plan", "alpha_step", "alpha_gap", "alpha_gap_resolve", "alpha_expert_search", "alpha_search", "alpha_crawl", "alpha_site", "alpha_source"].includes(name)) throw new Error(`Wait for worker integration before using ${name}`);
  }

  async spawn(orders: WorkOrder[], maxParallel = this.maxParallel): Promise<string[]> {
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 4) throw new Error("Worker concurrency must be 1–4");
    const replacements = new Set(orders.map(order => order.agentId).filter((id): id is string => !!id));
    const outstanding = [...this.attempts.entries()].filter(([id]) => {
      const instance = this.instance(id);
      return ["queued", "running", "returned"].includes(instance?.status ?? "") && !(instance?.status === "returned" && instance.agentId && replacements.has(instance.agentId));
    }).map(([, value]) => value.order);
    validateOrders([...outstanding, ...orders], 16);
    const catalog = await capabilityPool(this.input.dataRoot);
    const mcpPermissions = await new MCPPermissionStore(this.input.dataRoot).list();
    for (const order of orders) for (const id of order.capabilityIds ?? []) {
      const capability = catalog.find(item => item.id === id && item.enabled);
      if (!capability && !(order.capabilitySnapshots?.some(item => item.id === id && item.kind === "skill"))) throw new Error(`Capability is unavailable: ${id}`);
      if (!capability) continue;
      if (capability.kind === "builtin-tool" && this.input.plugins?.[capability.source as "comfyui"] === false) throw new Error(`Built-in plugin is disabled: ${capability.source}`);
      if (orderKind(order) !== "execute" && capability.kind === "builtin-tool") throw new Error(`Read-only worker cannot use ${id}`);
      if (orderKind(order) !== "execute" && capability.kind === "mcp-server") throw new Error(`Read-only worker needs individual MCP tool bindings: ${id}`);
      if (orderKind(order) !== "execute" && capability.kind === "mcp-tool" && mcpPermissions[id] !== "read") throw new Error(`Read-only worker requires read permission for ${id}`);
    }
    const ids = new Set(orders.map(order => order.id));
    for (const order of orders) for (const dep of order.dependsOn ?? []) {
      if (!ids.has(dep) && this.ledger.state.cognition?.nodes.find(node => node.id === dep)?.status !== "done") throw new Error(`Unknown or incomplete dependency: ${order.id} -> ${dep}`);
    }
    if (this.input.remainingCalls() - this.reservedCalls < orders.length * workerToolCalls) throw new Error("Task-wide tool budget cannot reserve these workers");
    if (this.input.remainingTimeMs && this.input.remainingTimeMs() - this.reservedTimeMs < orders.length * workerWallTimeMs) throw new Error("Task-wide time budget cannot reserve these workers");
    await ensureWorktreeBase(this.ledger.state.projectRoot, ["generated", "copy"].includes(this.ledger.state.workspaceOrigin?.kind ?? ""));
    const workerModels = (await new SettingsStore(this.input.dataRoot).get()).workerModels;
    this.maxParallel = maxParallel;
    this.startMessagePoll();
    liveSupervisors.set(this.ledger.state.id, this);
    this.releaseBrowser("coordinator");
    const assigned: string[] = [];
    for (const requested of orders) {
      const order = { ...requested, kind: orderKind(requested), modelSelector: workerModels[WORKER_MODEL_KEY[orderKind(requested)]] ?? this.input.modelSelector };
      const id = order.instanceId!;
      if (!id) throw new Error("Worker instance ID is required");
      const bound = orderExpert(order);
      await this.ledger.queueWorker({ id, parentId: this.input.parentId, order, expert: bound ? { id: bound.id, name: bound.name, hash: bound.hash } : undefined });
      this.attempts.set(id, { order, controller: new AbortController(), reserved: true });
      assigned.push(id);
      this.reservedCalls += workerToolCalls;
      this.reservedTimeMs += workerWallTimeMs;
    }
    this.pump();
    this.notify();
    return assigned;
  }

  async continue(agentId: string, instruction: string, kind?: PlanNodeKind, addedCapabilities: string[] = [], install?: WorkOrder["install"]): Promise<string> {
    if (!instruction.trim()) throw new Error("Continuation instruction is required");
    if (kind && !["investigate", "execute", "review"].includes(kind)) throw new Error("Invalid subagent kind");
    const agent = this.ledger.state.cognition?.agents?.find(item => item.id === agentId);
    if (!agent) throw new Error("Persistent subagent not found");
    const prior = this.instance(agent.lastAttemptId);
    if (!prior?.order || ["queued", "running"].includes(prior.status)) throw new Error("Subagent run is still active");
    const catalog = await capabilityPool(this.input.dataRoot);
    for (const capability of addedCapabilities) if (!catalog.some(item => item.id === capability && item.enabled)) throw new Error(`Capability is unavailable: ${capability}`);
    const capabilityIds = [...new Set([...(agent.capabilityIds ?? prior.order.capabilityIds ?? []), ...addedCapabilities])];
    const id = randomUUID();
    const { mode: _legacyMode, ...priorOrder } = prior.order; // continued orders carry `kind` only
    const order: WorkOrder = { ...priorOrder, agentId, instanceId: id, kind: kind ?? agent.kind,
      objective: `${prior.order.objective}\nFollow-up: ${instruction.trim()}`,
      decisionReason: `Continue the assigned result: ${instruction.trim()}`.slice(0, 500),
      ownedPaths: kind && kind !== "execute" ? [] : prior.order.ownedPaths,
      readPaths: [...new Set(prior.order.readPaths ?? [])],
      skillIds: [...agent.skillIds], skillSnapshots: agent.skillSnapshots?.map(item => ({ ...item })), expert: agent.expert,
      capabilityIds, capabilitySnapshots: agent.capabilitySnapshots?.map(item => ({ ...item })), contextRevision: (agent.contextRevision ?? 1) + (install || addedCapabilities.some(item => !(agent.capabilityIds ?? []).includes(item)) ? 1 : 0),
      install,
      contractVersion: this.ledger.state.contractVersion ?? 1,
      cognitionRevision: this.ledger.state.cognition?.revision ?? 1,
      baseRevision: this.ledger.state.revision ?? undefined,
    };
    const report = prior.workRoot ? await readFile(join(prior.workRoot, "merge.json"), "utf8").then(value => JSON.parse(value) as WorkBatchReport).catch(() => null) : null;
    if (orderKind(order) !== "execute" && prior.integration !== "merged" && report?.changes[prior.orderId]?.length) throw new Error("Integrate or discard prior source edits before switching this subagent to a read-only mode");
    order.readPaths = [...new Set([...(order.readPaths ?? []), ...(prior.integration === "merged" ? [] : report?.results[prior.orderId]?.readPaths ?? []).map(stripReadSelector)])];
    await this.spawn([order], this.maxParallel);
    return id;
  }

  async resolveRequest(requestId: string, action: "grant" | "answer" | "install" | "reject", reason: string, options: { capabilityIds?: string[]; argv?: string[]; targetEnvironment?: string; availabilityPath?: string; network?: boolean } = {}): Promise<{ status: string; runId?: string; approvalId?: string }> {
    const request = this.ledger.state.workerRequests?.find(item => item.id === requestId);
    if (!request) throw new Error("Worker request not found");
    if (request.status === "applied" || request.status === "rejected") return { status: request.status, runId: request.resolutionRunId, approvalId: request.approvalId };
    if (!reason.trim() || reason.length > 500) throw new Error("Resolution reason is required");
    if ((this.ledger.state.contractVersion ?? 1) !== request.contractVersion) throw new Error("Task contract changed; review the worker request again");
    const agent = this.ledger.state.cognition?.agents?.find(item => item.id === request.agentId);
    if (!agent || ["queued", "running"].includes(agent.status)) throw new Error("Subagent is unavailable for request resolution");
    if (action === "reject") {
      await this.mailbox.send(request.agentId, "decision", reason, request.id, request.id);
      await this.ledger.updateWorkerRequest(request.id, { status: "rejected", reason });
      await this.mailbox.inbox([request.id]);
      return { status: "rejected" };
    }
    if (action === "install") {
      if (request.kind !== "dependency" || agent.kind !== "execute") throw new Error("Dependency installation requires an implementing worker request");
      const argv = request.installArgv ?? options.argv ?? request.proposedArgv;
      const cwdRelative = request.cwdRelative ?? options.targetEnvironment ?? request.targetEnvironment ?? ".";
      const availabilityPath = request.availabilityPath ?? options.availabilityPath;
      const network = request.installNetwork ?? options.network ?? request.network ?? false;
      if (!argv?.length || argv.length > 16 || cwdRelative.length > 300 || !availabilityPath || availabilityPath.length > 300) throw new Error("Exact dependency command, target environment, and availability path are required");
      const workspace = join(this.input.dataRoot, "worker-agents", this.ledger.state.id, request.agentId, "project");
      const target = resolve(workspace, cwdRelative);
      const relativeTarget = relative(workspace, target);
      if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget) || !await stat(target).then(item => item.isDirectory(), () => false)) throw new Error("Dependency target is not inside the worker workspace");
      const canonicalTarget = relative(await realpath(workspace), await realpath(target));
      if (canonicalTarget.startsWith("..") || isAbsolute(canonicalTarget)) throw new Error("Dependency target escapes the worker workspace through a link");
      const artifact = resolve(target, availabilityPath);
      const relativeArtifact = relative(target, artifact);
      if (!relativeArtifact || relativeArtifact.startsWith("..") || isAbsolute(relativeArtifact)) throw new Error("Availability path must be inside the dependency target");
      const approvals = commandApprovalStore(this.input.dataRoot);
      const approval = request.approvalId
        ? (await approvals.list(this.ledger.state.id)).find(item => item.id === request.approvalId)
        : await approvals.request(this.ledger.state.id, target, argv, "other", network, request.id);
      if (!approval || approval.cwd !== target || approval.contextId !== request.id || JSON.stringify(approval.argv) !== JSON.stringify(argv) || !!approval.network !== network) throw new Error("Stored installation approval does not match the request");
      if (!request.approvalId || request.status === "uncertain") await this.ledger.updateWorkerRequest(request.id, { status: "awaiting-approval", reason, approvalId: approval.id, installArgv: argv, cwdRelative, availabilityPath, installNetwork: network });
      if (approval.status === "pending" && this.ledger.state.permissionMode !== "full" && this.ledger.state.permissionMode !== "auto") { await this.mailbox.inbox([request.id]); return { status: "awaiting-approval", approvalId: approval.id }; }
      if (approval.status === "denied") { await this.ledger.updateWorkerRequest(request.id, { status: "rejected", reason: "Installation approval denied" }); await this.mailbox.inbox([request.id]); return { status: "rejected", approvalId: approval.id }; }
      if (["running", "uncertain"].includes(approval.status) || approval.status === "complete" && (approval.result?.exitCode !== 0 || approval.result.revision !== await fingerprintSource(target))) { await this.ledger.updateWorkerRequest(request.id, { status: "uncertain", reason: "Installation receipt requires inspection", commandReceipt: { id: approval.id, status: approval.status, exitCode: approval.result?.exitCode, logPath: approval.result?.logPath, revision: approval.result?.revision } }); return { status: "uncertain", approvalId: approval.id }; }
      await this.mailbox.send(request.agentId, "decision", reason, request.id, request.id);
      const runId = await this.continue(request.agentId, `Dependency request ${request.id}: ${reason}`, "execute", [], { requestId: request.id, approvalId: approval.id, argv, cwdRelative, availabilityPath, network });
      await this.ledger.updateWorkerRequest(request.id, { status: "awaiting-approval", reason, resolutionRunId: runId });
      await this.mailbox.inbox([request.id]);
      return { status: "running", runId, approvalId: approval.id };
    }
    const ids = action === "grant" ? [...new Set(options.capabilityIds ?? request.capabilityIds)] : [];
    if (action === "grant" && !ids.length) throw new Error("Grant requires selected capabilities");
    await this.mailbox.send(request.agentId, "decision", reason, request.id, request.id);
    const runId = await this.continue(request.agentId, reason, undefined, ids);
    await this.ledger.updateWorkerRequest(request.id, { status: "applied", reason, resolutionRunId: runId });
    await this.mailbox.inbox([request.id]);
    return { status: "applied", runId };
  }

  async resumeApprovedRequest(requestId: string): Promise<void> {
    const request = this.ledger.state.workerRequests?.find(item => item.id === requestId);
    if (request?.status !== "awaiting-approval" || !request.approvalId) return;
    await this.resolveRequest(requestId, "install", request.reason ?? "Approved dependency installation");
  }

  private pump(): void {
    for (const [id, attempt] of this.attempts) {
      if (this.active.size >= this.maxParallel) break;
      if (attempt.settling) continue;
      if (this.instance(id)?.status !== "queued") continue;
      const dependencies = attempt.order.dependsOn ?? [];
      const states = dependencies.map(dep => {
        const attempt = [...this.attempts.entries()].findLast(([, value]) => value.order.id === dep);
        if (attempt) return this.instance(attempt[0])?.status === "completed" ? "done" : ["failed", "blocked", "cancelled"].includes(this.instance(attempt[0])?.status ?? "") ? "waiting" : "active";
        return this.ledger.state.cognition?.nodes.find(node => node.id === dep)?.status;
      });
      if (states.some(state => state === "waiting" || state === "cancelled")) {
        attempt.settling = this.ledger.updateWorker(id, "blocked", { findings: ["Dependency did not complete"] }).then(() => { this.releaseReservation(attempt); this.notify(); });
        continue;
      }
      if (states.some(state => state !== "done")) continue;
      this.active.add(id);
      attempt.promise = this.execute(id, attempt).finally(() => { this.active.delete(id); this.pump(); this.notify(); });
    }
  }

  private async execute(id: string, attempt: Attempt): Promise<void> {
    const { ledger, dataRoot, modelSelector, browser, browserUrl, browserAccess, plugins, generation, comfyUrl } = this.input;
    const manager = this;
    const workspace = attempt.order.agentId ? join(dataRoot, "worker-agents", ledger.state.id, attempt.order.agentId, "project") : undefined;
    const signal = this.input.signal ? AbortSignal.any([this.input.signal, attempt.controller.signal]) : attempt.controller.signal;
    try {
      signal.throwIfAborted();
      await ledger.refreshRevision();
      signal.throwIfAborted();
      const agentId = attempt.order.agentId;
      const previous = agentId ? ledger.state.cognition?.instances?.filter(item => item.agentId === agentId && item.id !== id).at(-1) : undefined;
      let mergeBaseRoot: string | undefined;
      if (workspace) {
        if (previous?.workRoot) {
          if (!await Bun.file(join(workspace, ".git")).exists()) throw new Error("Persistent subagent workspace is missing");
          if (previous.integration === "merged") await prepareAgentWorkspace(ledger.state.projectRoot, workspace, join(previous.workRoot, previous.orderId));
          else {
            mergeBaseRoot = join(previous.workRoot, "base");
            const frozen = join(previous.workRoot, previous.orderId);
            if (await stat(frozen).then(item => item.isDirectory(), () => false)) await prepareAgentWorkspace(ledger.state.projectRoot, workspace, frozen, false);
          }
        } else await prepareAgentWorkspace(ledger.state.projectRoot, workspace);
      }
      const report = await (this.input.runWorkers ?? runModelWorkOrders)({
        projectRoot: ledger.state.projectRoot, dataRoot, taskId: ledger.state.id, baseRevision: ledger.state.revision!,
        orders: [attempt.order], batchId: id, deferMerge: true, isolate: "git-worktree", agentWorkspace: workspace, mergeBaseRoot, signal, modelSelector, browser, browserUrl, browserAccess, plugins, generation, comfyUrl,
        workerContext: { taskType: ledger.state.taskType, workspaceOrigin: ledger.state.workspaceOrigin, capabilities: ledger.state.capabilities, permissionMode: ledger.state.permissionMode },
        browserLease: { claim: worker => this.claimBrowser(worker), release: worker => this.releaseBrowser(worker) },
        async onWorkerEvent(order, state) {
          if (state === "started") { attempt.order.skillSnapshots = order.skillSnapshots; attempt.order.capabilitySnapshots = order.capabilitySnapshots; await ledger.updateWorker(id, "running", { skills: order.skillSnapshots ?? [], capabilities: order.capabilitySnapshots ?? [] }); manager.notify(); }
        },
        // The child's pid goes into the parent log so recovery can reap an orphan after a hard kill.
        async onWorkerStart(order, info) {
          await ledger.recordWorkerActivation({
            attemptId: id, orderId: order.id, ...(order.agentId ? { agentId: order.agentId } : {}), pid: info.pid,
            workRoot: join(dataRoot, "workers", ledger.state.id, id), ...(workspace ? { worktreePath: workspace } : {}),
          });
        },
        async onWorkerUsage(order, usage) {
          await ledger.recordRun({ model: usage.model, stage: "worker", instanceId: id, thinkingPolicyVersion: ROLE_THINKING_POLICY_VERSION, toolCalls: usage.incomplete ? workerToolCalls : usage.toolCalls, maxToolCalls: workerToolCalls, wallTimeMs: workerWallTimeMs, elapsedMs: usage.incomplete ? workerWallTimeMs : usage.elapsedMs, childElapsedMs: usage.elapsedMs, usageIncomplete: usage.incomplete, usage: usage.tokens, outcome: usage.outcome ?? "returned" });
        },
        async onInstallReceipt(order, receipt, available) {
          const requestId = order.install?.requestId;
          if (!requestId) return;
          const status = available ? "applied" : receipt.status === "denied" ? "rejected" : receipt.status === "pending" ? "awaiting-approval" : "uncertain";
          await ledger.updateWorkerRequest(requestId, { status, reason: status === "applied" ? "Dependency installed and available in worker workspace" : `Installation ${receipt.status}; availability ${available}`, commandReceipt: { id: receipt.id, status: receipt.status, exitCode: receipt.result?.exitCode, logPath: receipt.result?.logPath, revision: receipt.result?.revision } });
        },
      });
      if (signal.aborted) throw new Error("Worker cancelled");
      const outcome = report.results[attempt.order.id];
      if (outcome?.status === "needs-context") {
        const reason = outcome.findings?.join("; ") || report.reason || "Worker needs task input";
        if (!attempt.order.agentId && ledger.state.status === "active") await ledger.needInput(reason, "approval");
        await ledger.updateWorker(id, "blocked", { workRoot: report.workRoot, findings: [reason], cognition: outcome.cognition });
        await ledger.recordWorkerResult({ attemptId: id, stopReason: report.stopReasons?.[attempt.order.id] ?? "needs-input", findings: [reason], ...(outcome.reviewVerdict ? { reviewVerdict: outcome.reviewVerdict } : {}), detail: report.reason });
        if (attempt.order.agentId) {
          await this.mailbox.collect();
          if (!(await this.mailbox.inbox()).some(message => message.fromRunId === id && message.kind === "request")) await this.mailbox.report(attempt.order.agentId, id, reason);
          await this.pollMessages();
        }
        this.input.onStatus?.(`子实例 ${attempt.order.id} 等待任务授权或输入`);
        return;
      }
      if (report.status !== "ready") {
        const reason = report.reason ?? "Worker result was rejected";
        const status = outcome?.status === "blocked" ? "blocked" : "failed";
        await ledger.updateWorker(id, status, { workRoot: report.workRoot, findings: [reason], cognition: outcome?.cognition });
        await ledger.recordWorkerResult({ attemptId: id, stopReason: report.stopReasons?.[attempt.order.id] ?? workerStopReason({ cancelled: signal.aborted, errorText: reason }), findings: [reason], ...(outcome?.reviewVerdict ? { reviewVerdict: outcome.reviewVerdict } : {}), detail: reason });
        if (status === "blocked" && attempt.order.agentId) {
          await this.mailbox.collect();
          if (!(await this.mailbox.inbox()).some(message => message.fromRunId === id && message.kind === "request")) await this.mailbox.report(attempt.order.agentId, id, reason);
          await this.pollMessages();
        }
        this.input.onStatus?.(`子实例 ${attempt.order.id} ${status === "blocked" ? "等待主代理" : "失败"}`);
        return;
      }
      await ledger.updateWorker(id, "returned", { workRoot: report.workRoot, worktreePath: workspace ?? join(report.workRoot, attempt.order.id), integration: "pending", findings: report.results[attempt.order.id]?.findings ?? [], cognition: outcome?.cognition });
      await ledger.recordWorkerResult({ attemptId: id, stopReason: report.stopReasons?.[attempt.order.id] ?? "completed", findings: outcome?.findings ?? [], ...(outcome?.reviewVerdict ? { reviewVerdict: outcome.reviewVerdict } : {}) });
      this.input.onStatus?.(`子实例 ${attempt.order.id} 已返回，等待检查和集成`);
    } catch (error) {
      const workRoot = join(dataRoot, "workers", ledger.state.id, id);
      const frozen = join(workRoot, attempt.order.id);
      const recoverable = await stat(join(workRoot, "base")).then(item => item.isDirectory(), () => false)
        && await stat(frozen).then(item => item.isDirectory(), () => false);
      await ledger.updateWorker(id, signal.aborted ? "cancelled" : "failed", { ...(recoverable ? { workRoot, worktreePath: workspace ?? frozen } : {}), findings: [attempt.cancelReason ?? (error instanceof Error ? error.message : String(error))] });
      const failureText = attempt.cancelReason ?? (error instanceof Error ? error.message : String(error));
      const stopReason: WorkerStopReason = error instanceof WorkerStopError ? error.stopReason : workerStopReason({ cancelled: signal.aborted || !!attempt.cancelReason, errorText: failureText });
      await ledger.recordWorkerResult({ attemptId: id, stopReason, findings: [failureText], detail: failureText });
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
        const done = () => { if (this.mailbox.pending || ids.some(id => !["queued", "running"].includes(this.instance(id)?.status ?? ""))) { clearTimeout(timer); this.listeners.delete(done); resolve(); } };
        const timer = setTimeout(() => { this.listeners.delete(done); resolve(); }, timeoutMs);
        this.listeners.add(done);
        done();
      });
    }
    return Promise.all(ids.map(id => presented ? this.inspect(id) : inspectWorkerAttempt(this.ledger, this.input.dataRoot, id)));
  }

  async integrate(id: string, reason = "Coordinator accepted the inspected result"): Promise<WorkBatchReport | { status: "accepted" }> {
    if (!reason.trim() || reason.length > 500) throw new Error("Integration reason is required");
    const attempt = this.attempts.get(id);
    if (!attempt || this.instance(id)?.status !== "returned") throw new Error("Worker attempt is not awaiting integration");
    if (!attempt.inspected) throw new Error("Inspect the worker result and diff before integration");
    const action = this.integration.then(async () => {
      if (this.instance(id)?.status !== "returned") throw new Error("Worker attempt is no longer awaiting integration");
      const result = await this.inspect(id);
      if (result.report?.status !== "ready") throw new Error("Worker output is not ready");
      await this.ledger.refreshRevision();
      const sourceRevision = this.ledger.state.revision;
      const report = await integratePreparedWorkOrder(this.ledger.state.projectRoot, this.input.dataRoot, this.ledger.state.id, id, attempt.order, this.input.signal);
      if (report.status !== "merged") throw new Error(report.reason ?? "Integration failed");
      await this.ledger.refreshRevision();
      await this.ledger.updateWorker(id, "completed", { integration: "merged", integrationDecision: { action: "integrate", reason: reason.trim(), runId: id, contractVersion: this.ledger.state.contractVersion ?? 1, sourceRevision, recordedAt: new Date().toISOString() } });
      this.pump(); this.notify();
      return report;
    });
    this.integration = action.catch(() => undefined);
    try { return await action; }
    catch (error) { await this.ledger.updateWorker(id, "returned", { integration: "conflict", findings: [error instanceof Error ? error.message : String(error)] }); throw error; }
  }

  async cancel(id: string, reason = "Cancelled by coordinator"): Promise<void> {
    if (!reason.trim() || reason.length > 500) throw new Error("Cancellation reason is required");
    const attempt = this.attempts.get(id);
    if (!attempt) throw new Error("Worker attempt not found");
    const state = this.instance(id)?.status;
    if (state === "returned") { await this.integration; if (this.instance(id)?.status !== "returned") throw new Error("Worker result was already integrated"); }
    if (state === "queued" && this.active.has(id)) {
      attempt.cancelReason = reason.trim();
      attempt.controller.abort(new Error(reason.trim()));
      await attempt.promise;
    } else if (state === "queued" || state === "returned") {
      if (state === "returned" && attempt.inspected) await this.ledger.refreshRevision();
      await this.ledger.updateWorker(id, "cancelled", { findings: [reason.trim()], ...(state === "returned" && attempt.inspected ? { integrationDecision: { action: "reject" as const, reason: reason.trim(), runId: id, contractVersion: this.ledger.state.contractVersion ?? 1, sourceRevision: this.ledger.state.revision, recordedAt: new Date().toISOString() } } : {}) });
      if (state === "queued") this.releaseReservation(attempt);
      this.pump(); this.notify();
    } else if (state === "running") { attempt.cancelReason = reason.trim(); attempt.controller.abort(new Error(reason.trim())); }
  }
  async cancelAll(): Promise<void> {
    for (const id of this.attempts.keys()) {
      const status = this.instance(id)?.status ?? "";
      if (["queued", "running", "returned"].includes(status)) await this.cancel(id);
      // An instance closed outside this supervisor (restart reconciliation) still leaves a live child: abort it too.
      else this.attempts.get(id)?.controller.abort(new Error("Cancelled by coordinator"));
    }
    await Promise.allSettled([...this.attempts.values()].flatMap(item => [item.promise, item.settling].filter((promise): promise is Promise<void> => !!promise)));
  }
  async cancelExecuting(): Promise<void> {
    for (const id of this.attempts.keys()) if (["queued", "running"].includes(this.instance(id)?.status ?? "")) await this.cancel(id);
    await Promise.allSettled([...this.attempts.values()].flatMap(item => [item.promise, item.settling].filter((promise): promise is Promise<void> => !!promise)));
  }
}
