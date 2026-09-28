import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { buildChildEnv } from "./child-env";
import { fingerprintSource } from "./task-ledger";
import { runFullAccessCommand, runSandboxCommand, SandboxUnavailableError } from "./sandbox-exec";
import { appendPlannedEvent, inspectLogTail, readEvents, taskLogDir } from "./task-events/log";
import type { PermissionMode, TaskLedger } from "./task-ledger";
import type { PauseReasonCode } from "./pause-reasons";

export interface CommandRequest {
  id: string;
  taskId: string;
  argv: string[];
  purpose: "check" | "other";
  cwd: string;
  network?: boolean;
  contextId?: string;
  scriptCommand?: string;
  status: "pending" | "approved" | "denied" | "running" | "complete" | "uncertain";
  createdAt: string;
  reason?: string;
  risk?: "normal" | "high";
  review?: { reviewer: "user" | "independent-agent" | "policy"; decision: "approved" | "denied" | "escalated"; reason: string; at: string };
  exactAction?: { tool: string; targets: string[]; arguments: Record<string, unknown>; digest: string };
  result?: { exitCode: number; logPath: string; revision: string };
}

export type IndependentReview = (request: CommandRequest, signal?: AbortSignal) => Promise<{ decision: "approve" | "deny" | "user"; reason: string }>;

/** A task event the store appends to its task's log; the log stamps `seq`/`at`/`actor`. */
type Emit = { type: string; payload: unknown };

/**
 * Appends one event to the parent task's log and rewrites the projection inside the log lock, so the JSON projection
 * never lags the log tip. `project` is the store's own writer (byte-identical to the pre-event-log one).
 */
async function appendToTaskLog(ledger: TaskLedger, event: Emit, project: () => Promise<void>): Promise<void> {
  const dir = taskLogDir(ledger.file);
  await appendPlannedEvent(
    dir,
    ledger.eventSeq,
    async () => ({ at: new Date().toISOString(), actor: ledger.actor, ...(ledger.runId ? { runId: ledger.runId } : {}), type: event.type, payload: event.payload }),
    async () => (await inspectLogTail(dir)).seq,
    async () => { await project(); },
  );
}

function requestedEvent(request: CommandRequest): Emit {
  const payload = {
    id: request.id,
    argv: request.argv,
    purpose: request.purpose,
    requestedAt: request.createdAt,
    ...(request.risk !== undefined ? { risk: request.risk } : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    ...(request.network !== undefined ? { network: request.network } : {}),
    ...(request.exactAction ? { exactAction: request.exactAction.digest } : {}),
  };
  return { type: "approval/requested", payload };
}

function reviewedEvent(request: CommandRequest): Emit {
  const review = request.review!;
  const payload = { id: request.id, reviewer: review.reviewer, decision: review.decision, reason: review.reason, reviewedAt: review.at };
  return { type: "approval/reviewed", payload };
}

function claimedEvent(request: CommandRequest): Emit {
  const payload = { id: request.id, claimedAt: new Date().toISOString() };
  return { type: "approval/claimed", payload };
}

function finishedEvent(request: CommandRequest): Emit {
  const result = request.result;
  const payload = result
    ? { id: request.id, exitCode: result.exitCode, logPath: result.logPath, revision: result.revision, finishedAt: new Date().toISOString() }
    : { id: request.id, exitCode: 1, finishedAt: new Date().toISOString() };
  return { type: "approval/finished", payload };
}

export function commandRisk(argv: string[]): "normal" | "high" {
  const text = argv.join(" ").toLowerCase();
  return /(?:^|[\s;&|])(?:del|erase|rd|rmdir|rm|rimraf|remove-item|format|diskpart|reg(?:\.exe)?|schtasks|sc(?:\.exe)?|net(?:\.exe)?|icacls|takeown|git\s+push|git\s+reset\s+--hard|npm\s+publish|bun\s+publish|curl(?:\.exe)?.*(?:-t|--upload-file|--data|-d)|invoke-restmethod|start-process\s+-verb\s+runas)(?:[\s;&|]|$)/i.test(text)
    || /(?:[\\/"']|^)(?:\.ssh|\.aws|\.azure|\.codex|\.env(?:\.[^\\/\s"']*)?|credentials?(?:\.[^\\/\s"']*)?|id_(?:rsa|ed25519)|\.npmrc)(?:[\\/\s"']|$)/i.test(text)
    ? "high" : "normal";
}

async function scriptCommand(cwd: string, argv: string[]): Promise<string | undefined> {
  if (argv[1] !== "run" || !argv[2]) return undefined;
  const name = argv[2];
  const file = await readFile(join(cwd, "package.json"), "utf8").catch(() => null);
  if (!file) return undefined;
  const script = (JSON.parse(file) as { scripts?: Record<string, unknown> }).scripts?.[name];
  return typeof script === "string" ? script : undefined;
}

const parameters = type({ argv: "string[]", purpose: "'check' | 'other'", "network?": "boolean" });

export class CommandApprovalStore {
  private queue: Promise<void> = Promise.resolve();
  /** Parent task ledgers keyed by task id; appends go to the log of the task the request belongs to. */
  private readonly ledgers = new Map<string, TaskLedger>();
  /** Tasks whose pre-event-log projection has been imported, so the import runs once per store. */
  private readonly imported = new Set<string>();
  constructor(private readonly dataRoot: string) {}

  /**
   * Binds a task's ledger so state changes also append events to its log and project from the fold. The store is a
   * per-`dataRoot` singleton that serves many tasks, so each ledger registers under its own task id. Call sites that
   * build the store without a ledger (the runner, the server context) are unchanged: without a ledger no events are
   * appended and the projection behaves exactly as before.
   */
  attach(ledger: TaskLedger): void {
    this.ledgers.set(ledger.state.id, ledger);
  }

  private directory(taskId: string): string { return join(this.dataRoot, "approvals", taskId); }
  private file(taskId: string, id: string): string { return join(this.directory(taskId), `${id}.json`); }

  private async save(request: CommandRequest): Promise<void> {
    await mkdir(this.directory(request.taskId), { recursive: true });
    const file = this.file(request.taskId, request.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(request, null, 2));
    await rename(temporary, file);
  }

  /** Writes the projection and appends the matching event to the task log; without a ledger it just writes. */
  private async persist(request: CommandRequest, event: Emit | null): Promise<void> {
    const ledger = this.ledgers.get(request.taskId);
    if (!ledger || !event) { await this.save(request); return; }
    await appendToTaskLog(ledger, event, () => this.save(request));
  }

  /**
   * Imports a task's pre-event-log approvals once, as `approval/requested` events, leaving the projection files
   * untouched. Runs on the first write/reconcile for a task that has request files but no approval events yet; the
   * presence of an approval event in the log (durable across restarts) is what makes the import one-shot.
   */
  private async ensureImported(taskId: string): Promise<void> {
    if (this.imported.has(taskId)) return;
    const ledger = this.ledgers.get(taskId);
    if (!ledger) return;
    const events = await readEvents(taskLogDir(ledger.file));
    if (events.some(event => event.type === "approval/requested")) { this.imported.add(taskId); return; }
    for (const request of await this.list(taskId)) await appendToTaskLog(ledger, requestedEvent(request), async () => {});
    this.imported.add(taskId);
  }

  async list(taskId: string): Promise<CommandRequest[]> {
    const names = (await readdir(this.directory(taskId)).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    return (await Promise.all(names.map(async name => JSON.parse(await readFile(join(this.directory(taskId), name), "utf8")) as CommandRequest))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async reconcile(taskId: string): Promise<void> {
    await this.serial(async () => {
      await this.ensureImported(taskId);
      for (const request of await this.list(taskId)) {
        if (request.status === "running") { request.status = "uncertain"; await this.persist(request, finishedEvent(request)); }
      }
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  request(taskId: string, cwd: string, argv: string[], purpose: "check" | "other", network = false, contextId?: string): Promise<CommandRequest> {
    if (!argv.length || argv.length > 16 || argv.some(arg => typeof arg !== "string" || !arg || arg.length > 1000 || /[\r\n\0]/.test(arg))) throw new Error("Command arguments are invalid");
    return this.serial(async () => {
      await this.ensureImported(taskId);
      const script = await scriptCommand(cwd, argv);
      const existing = (await this.list(taskId)).find(item => item.status !== "complete" && item.cwd === cwd && item.purpose === purpose && !!item.network === network && item.contextId === contextId && item.scriptCommand === script && JSON.stringify(item.argv) === JSON.stringify(argv));
      if (existing) return existing;
      const risk = commandRisk([...argv, ...(script ? [script] : [])]);
      const request: CommandRequest = { id: randomUUID(), taskId, cwd, argv, purpose, network, ...(contextId ? { contextId } : {}), ...(script ? { scriptCommand: script } : {}), status: "pending", createdAt: new Date().toISOString(), reason: network ? "Command requests network access" : "Command is not a configured project check", risk };
      await this.persist(request, requestedEvent(request));
      return request;
    });
  }

  decide(taskId: string, id: string, approved: boolean): Promise<CommandRequest> {
    return this.serial(async () => {
      await this.ensureImported(taskId);
      const request = (await this.list(taskId)).find(item => item.id === id);
      if (!request || request.status !== "pending") throw new Error("Approval request is not pending");
      request.status = approved ? "approved" : "denied";
      request.review = { reviewer: "user", decision: approved ? "approved" : "denied", reason: "Workbench decision", at: new Date().toISOString() };
      await this.persist(request, reviewedEvent(request));
      return request;
    });
  }

  async requestAction(taskId: string, cwd: string, action: { tool: string; targets: string[]; arguments: Record<string, unknown>; digest: string }, reason: string): Promise<CommandRequest> {
    const request = await this.request(taskId, cwd, ["alpha-file", action.tool, action.targets.join(", ").slice(0, 400), action.digest], "other");
    if (request.exactAction) return request;
    return this.serial(async () => {
      request.exactAction = action;
      request.risk = "high";
      request.reason = reason;
      // The exact-action decoration is projection-only detail (the event carries at most its digest); `request` above
      // already appended `approval/requested` for this id.
      await this.persist(request, null);
      return request;
    });
  }

  claimAction(taskId: string, id: string): Promise<CommandRequest> {
    return this.serial(async () => {
      await this.ensureImported(taskId);
      const request = (await this.list(taskId)).find(item => item.id === id);
      if (!request || !request.exactAction || request.status !== "approved") throw new Error("File approval is not available for one-time execution");
      request.status = "running";
      await this.persist(request, claimedEvent(request));
      return request;
    });
  }

  finishAction(taskId: string, id: string, success: boolean, revision: string): Promise<CommandRequest> {
    return this.serial(async () => {
      await this.ensureImported(taskId);
      const request = (await this.list(taskId)).find(item => item.id === id);
      if (!request || request.status !== "running") throw new Error("File approval was not running");
      request.status = success ? "complete" : "uncertain";
      request.result = { exitCode: success ? 0 : 1, logPath: this.file(taskId, id), revision };
      await this.persist(request, finishedEvent(request));
      return request;
    });
  }

  async execute(taskId: string, cwd: string, argv: string[], purpose: "check" | "other", signal?: AbortSignal, permission?: { mode: PermissionMode; roots: string[] }, reviewer?: IndependentReview, network = false, existingId?: string, contextId?: string): Promise<CommandRequest> {
    signal?.throwIfAborted();
    const request = existingId ? (await this.list(taskId)).find(item => item.id === existingId) : await this.request(taskId, cwd, argv, purpose, network, contextId);
    if (!request || request.taskId !== taskId || request.cwd !== cwd || request.purpose !== purpose || !!request.network !== network || request.contextId !== contextId || JSON.stringify(request.argv) !== JSON.stringify(argv)) throw new Error("Approved command does not match the worker request");
    if (request.status === "complete") {
      if (!request.result || request.result.revision !== await fingerprintSource(cwd)) throw new Error("Completed installation workspace changed; inspect before retrying");
      return request;
    }
    if (network && permission?.mode !== "full" && request.risk !== "high") {
      request.risk = "high";
      await this.serial(() => this.persist(request, null));
    }
    if (request.status === "pending" && permission && request.risk !== "high") {
      if (permission.mode === "full") {
        await this.serial(async () => {
          request.status = "approved";
          request.review = { reviewer: "policy", decision: "approved", reason: "Full-access mode permits a command not classified as high risk", at: new Date().toISOString() };
          await this.persist(request, reviewedEvent(request));
        });
      } else if (permission.mode === "auto") {
        if (!reviewer) throw new Error("Independent reviewer is unavailable");
        let review: Awaited<ReturnType<IndependentReview>>;
        try { review = await reviewer(request, signal); }
        catch (error) {
          request.reason = `Independent reviewer unavailable: ${error instanceof Error ? error.message : String(error)}`;
          await this.serial(() => this.persist(request, null));
          return request;
        }
        signal?.throwIfAborted();
        await this.serial(async () => {
          request.status = review.decision === "approve" ? "approved" : review.decision === "deny" ? "denied" : "pending";
          request.review = { reviewer: "independent-agent", decision: review.decision === "approve" ? "approved" : review.decision === "deny" ? "denied" : "escalated", reason: review.reason, at: new Date().toISOString() };
          await this.persist(request, reviewedEvent(request));
        });
      }
    }
    if (request.status !== "approved") return request;
    if (request.scriptCommand !== await scriptCommand(cwd, argv)) throw new Error("Approved project script changed before execution");
    await this.serial(async () => {
      const current = (await this.list(taskId)).find(item => item.id === request.id);
      if (current?.status !== "approved") throw new Error("Approved command changed before execution");
      request.status = "running";
      await this.persist(request, claimedEvent(request));
    });
    const logDir = join(this.dataRoot, "command-logs");
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${taskId}-${request.id}.log`);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const abort = () => child?.kill();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      signal?.throwIfAborted();
      if (permission) {
        const result = permission.mode === "full"
          ? await runFullAccessCommand({ cwd, dataRoot: this.dataRoot, argv, signal })
          : await runSandboxCommand({ cwd, dataRoot: this.dataRoot, roots: permission.roots, argv, signal, network });
        await writeFile(logPath, `command=${JSON.stringify(argv)}\ncwd=${cwd}\nnetwork=${network}\nexit=${result.exitCode}\nsandbox=${permission.mode !== "full"}\n${result.stdout}\n${result.stderr}`, { flag: "wx" });
        request.status = result.timedOut || result.cancelled ? "uncertain" : "complete";
        request.result = { exitCode: result.exitCode, logPath, revision: await fingerprintSource(cwd) };
        await this.persist(request, finishedEvent(request));
        return request;
      }
      child = Bun.spawn(argv, { cwd, env: buildChildEnv(), stdout: "pipe", stderr: "pipe" });
      if (!child.stdout || typeof child.stdout === "number" || !child.stderr || typeof child.stderr === "number") throw new Error("Command output is unavailable");
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(abort, 120_000);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      await writeFile(logPath, `command=${JSON.stringify(argv)}\ncwd=${cwd}\nexit=${exitCode}\n${stdout}\n${stderr}`, { flag: "wx" });
      request.status = "complete";
      request.result = { exitCode, logPath, revision: await fingerprintSource(cwd) };
      await this.persist(request, finishedEvent(request));
      return request;
    } catch (error) {
      request.status = "uncertain";
      await this.persist(request, finishedEvent(request));
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

const stores = new Map<string, CommandApprovalStore>();
export function commandApprovalStore(dataRoot: string): CommandApprovalStore {
  let store = stores.get(dataRoot);
  if (!store) { store = new CommandApprovalStore(dataRoot); stores.set(dataRoot, store); }
  return store;
}

export function createCommandTool(store: CommandApprovalStore, taskId: string, cwd: string, permission?: { mode: PermissionMode; roots: string[] }, reviewer?: IndependentReview, onNeedsInput?: (reason: string, code?: PauseReasonCode) => Promise<void>): CustomTool<typeof parameters> {
  return {
    name: "alpha_command",
    label: "Request an approved command",
    description: "Run or request an exact command outside configured checks. Approval follows this task's permission mode; high-risk commands require the user.",
    parameters,
    loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        const result = await store.execute(taskId, cwd, args.argv, args.purpose, signal, permission, reviewer, args.network === true);
        if (result.status === "pending" && !signal?.aborted) await onNeedsInput?.(`Command approval required (${result.risk ?? "normal"}): ${result.argv.join(" ")}. ${result.reason ?? ""}`);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.status !== "complete" || result.result?.exitCode !== 0 };
      } catch (error) {
        if (error instanceof SandboxUnavailableError) await onNeedsInput?.(error.message, "sandbox");
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
