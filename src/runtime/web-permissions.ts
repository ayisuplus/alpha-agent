import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WebApproval = { id: string; taskId: string; kind: "read" | "write"; scope: string; actionId?: string; details?: string; status: "pending" | "granted" | "approved" | "denied" | "running" | "complete" | "uncertain"; requestedAt: string; decidedAt?: string };
export class WebApprovalRequired extends Error {
  constructor(readonly approval: WebApproval) { super(`Web ${approval.kind} permission required for ${approval.scope}`); }
}

export class WebPermissionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataRoot: string) {}
  private file(taskId: string): string { return join(this.dataRoot, "web-approvals", `${taskId}.json`); }
  async list(taskId: string): Promise<WebApproval[]> { return JSON.parse(await readFile(this.file(taskId), "utf8").catch(() => "[]")) as WebApproval[]; }
  private async mutate<T>(taskId: string, work: (items: WebApproval[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const items = await this.list(taskId);
      const result = work(items);
      const file = this.file(taskId);
      await mkdir(join(this.dataRoot, "web-approvals"), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(items, null, 2));
      await rename(temp, file);
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
      if (existing) return existing;
      const created: WebApproval = { id: randomUUID(), taskId, scope, kind, ...(actionId ? { actionId } : {}), ...(details ? { details: details.slice(0, 1000) } : {}), status: "pending", requestedAt: new Date().toISOString() };
      items.push(created);
      return created;
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
      return item;
    });
  }
  async grantRead(taskId: string, scope: string): Promise<void> {
    if (!/^domain:[A-Za-z0-9.-]{1,250}$/.test(scope)) throw new Error("Invalid web read scope");
    await this.mutate(taskId, items => {
      const existing = items.find(entry => entry.scope === scope && entry.kind === "read");
      if (existing) { existing.status = "granted"; existing.decidedAt = new Date().toISOString(); return; }
      items.push({ id: randomUUID(), taskId, scope, kind: "read", status: "granted", requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString() });
    });
  }
  async beginWrite(taskId: string, id: string): Promise<void> {
    await this.mutate(taskId, items => {
      const item = items.find(entry => entry.id === id && entry.kind === "write" && entry.status === "approved");
      if (!item) throw new Error("Web write is not approved or has already started");
      item.status = "running";
    });
  }
  async finishWrite(taskId: string, id: string, uncertain = false): Promise<void> {
    await this.mutate(taskId, items => {
      const item = items.find(entry => entry.id === id && entry.kind === "write" && entry.status === "running");
      if (!item) throw new Error("Web write receipt is missing");
      item.status = uncertain ? "uncertain" : "complete";
    });
  }
  async reconcile(taskId: string): Promise<void> {
    await this.mutate(taskId, items => { for (const item of items) if (item.status === "running") item.status = "uncertain"; });
  }
}
