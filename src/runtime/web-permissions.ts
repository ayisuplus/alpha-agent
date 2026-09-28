import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendPlannedEvent, inspectLogTail, readEvents, taskLogDir } from "./task-events/log";
import type { TaskLedger } from "./task-ledger";

export type WebApproval = { id: string; taskId: string; kind: "read" | "write"; scope: string; actionId?: string; details?: string; status: "pending" | "granted" | "approved" | "denied" | "running" | "complete" | "uncertain"; requestedAt: string; decidedAt?: string };
export class WebApprovalRequired extends Error {
  constructor(readonly approval: WebApproval) { super(`Web ${approval.kind} permission required for ${approval.scope}`); }
}

/** A task event the store appends to its task's log; the log stamps `seq`/`at`/`actor`. */
type Emit = { type: string; payload: unknown };

/** Appends one event to the task log and runs `project` (the store's writer) inside the lock so it never lags the tip. */
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

function requestedEvent(item: WebApproval): Emit {
  const payload = {
    id: item.id,
    scope: item.scope,
    kind: item.kind,
    ...(item.actionId !== undefined ? { actionId: item.actionId } : {}),
    requestedAt: item.requestedAt,
  };
  return { type: "web-approval/requested", payload };
}

export class WebPermissionStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** Parent task ledgers keyed by task id; appends go to the log of the task the approval belongs to. */
  private readonly ledgers = new Map<string, TaskLedger>();
  /** Tasks whose pre-event-log web approvals have been imported, so the import runs once per store. */
  private readonly imported = new Set<string>();
  constructor(private readonly dataRoot: string) {}

  /**
   * Binds a task's ledger so state changes also append events to its log. Without a ledger (the runner and the server
   * context build the store without one) no events are appended and the projection behaves exactly as before.
   */
  attach(ledger: TaskLedger): void {
    this.ledgers.set(ledger.state.id, ledger);
  }

  private file(taskId: string): string { return join(this.dataRoot, "web-approvals", `${taskId}.json`); }
  async list(taskId: string): Promise<WebApproval[]> { return JSON.parse(await readFile(this.file(taskId), "utf8").catch(() => "[]")) as WebApproval[]; }

  /**
   * Imports a task's pre-event-log web approvals once, as `web-approval/requested` events, without rewriting the
   * projection file. A `web-approval/requested` already in the log makes the import one-shot across restarts.
   */
  private async ensureImported(taskId: string): Promise<void> {
    if (this.imported.has(taskId)) return;
    const ledger = this.ledgers.get(taskId);
    if (!ledger) return;
    const events = await readEvents(taskLogDir(ledger.file));
    if (events.some(event => event.type === "web-approval/requested")) { this.imported.add(taskId); return; }
    for (const item of await this.list(taskId)) await appendToTaskLog(ledger, requestedEvent(item), async () => {});
    this.imported.add(taskId);
  }

  private async mutate<T>(taskId: string, work: (items: WebApproval[]) => { result: T; event: Emit | null }): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ensureImported(taskId);
      const items = await this.list(taskId);
      const { result, event } = work(items);
      const write = async () => {
        const file = this.file(taskId);
        await mkdir(join(this.dataRoot, "web-approvals"), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(items, null, 2));
        await rename(temp, file);
      };
      const ledger = this.ledgers.get(taskId);
      // With a ledger the projection is rewritten inside the append lock, so it never lags the log tip.
      if (ledger && event) await appendToTaskLog(ledger, event, write);
      else await write();
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async require(taskId: string, scope: string, kind: "read" | "write", actionId?: string, details?: string): Promise<WebApproval> {
    if (!/^(provider|domain|tab|action):[A-Za-z0-9._:/-]{1,250}$/.test(scope)) throw new Error("Invalid web permission scope");
    if (kind === "write" && (!actionId || !/^[A-Za-z0-9._:-]{1,200}$/.test(actionId))) throw new Error("External action needs a stable request ID");
    const item = await this.mutate(taskId, items => {
      const reused = kind === "write" && items.find(entry => entry.kind === "write" && entry.actionId === actionId && entry.scope !== scope);
      if (reused) throw new Error("External action request ID was reused with different arguments");
      const existing = items.find(entry => entry.scope === scope && entry.kind === kind && (kind === "read" || entry.actionId === actionId));
      if (existing) return { result: existing, event: null };
      const created: WebApproval = { id: randomUUID(), taskId, scope, kind, ...(actionId ? { actionId } : {}), ...(details ? { details: details.slice(0, 1000) } : {}), status: "pending", requestedAt: new Date().toISOString() };
      items.push(created);
      return { result: created, event: requestedEvent(created) };
    });
    if (item.status === "denied") throw new Error(`Web ${kind} permission was denied for ${scope}`);
    if (item.status === "uncertain" || item.status === "running") throw new Error("External web action outcome is uncertain; inspect the site before retrying");
    if (item.status === "pending") throw new WebApprovalRequired(item);
    return item;
  }

  async decide(taskId: string, id: string, approved: boolean): Promise<WebApproval> {
    return this.mutate(taskId, items => {
      const item = items.find(entry => entry.id === id && entry.status === "pending");
      if (!item) throw new Error("Web approval is no longer pending");
      item.status = approved ? item.kind === "read" ? "granted" : "approved" : "denied";
      item.decidedAt = new Date().toISOString();
      return { result: item, event: { type: "web-approval/decided", payload: { id, approved, decidedAt: item.decidedAt } } };
    });
  }

  async grantRead(taskId: string, scope: string): Promise<void> {
    if (!/^domain:[A-Za-z0-9.-]{1,250}$/.test(scope)) throw new Error("Invalid web read scope");
    await this.mutate(taskId, items => {
      const grantedAt = new Date().toISOString();
      const existing = items.find(entry => entry.scope === scope && entry.kind === "read");
      if (existing) { existing.status = "granted"; existing.decidedAt = grantedAt; }
      else items.push({ id: randomUUID(), taskId, scope, kind: "read", status: "granted", requestedAt: grantedAt, decidedAt: grantedAt });
      return { result: undefined, event: { type: "web-approval/read-granted", payload: { scope, grantedAt } } };
    });
  }

  async beginWrite(taskId: string, id: string): Promise<void> {
    await this.mutate(taskId, items => {
      const item = items.find(entry => entry.id === id && entry.kind === "write" && entry.status === "approved");
      if (!item) throw new Error("Web write is not approved or has already started");
      item.status = "running";
      return { result: undefined, event: { type: "web-approval/write-begun", payload: { id, begunAt: new Date().toISOString() } } };
    });
  }

  async finishWrite(taskId: string, id: string, uncertain = false): Promise<void> {
    await this.mutate(taskId, items => {
      const item = items.find(entry => entry.id === id && entry.kind === "write" && entry.status === "running");
      if (!item) throw new Error("Web write receipt is missing");
      item.status = uncertain ? "uncertain" : "complete";
      return { result: undefined, event: { type: "web-approval/write-finished", payload: { id, uncertain, finishedAt: new Date().toISOString() } } };
    });
  }

  async reconcile(taskId: string): Promise<void> {
    await this.mutate(taskId, items => {
      for (const item of items) if (item.status === "running") item.status = "uncertain";
      return { result: undefined, event: { type: "web-approval/reconciled", payload: { reconciledAt: new Date().toISOString() } } };
    });
  }
}
