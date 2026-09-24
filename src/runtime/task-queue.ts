import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface QueueItem { id: string; taskId: string; instruction: string; status: "pending" | "running" | "complete" | "failed"; createdAt: string; scheduledFor?: string; missedCount?: number; runId?: string; startedAt?: string; finishedAt?: string; result?: string }
export interface LocalSchedule { id: string; taskId: string; instruction: string; intervalMinutes: number | null; nextRunAt: string; active: boolean; createdAt: string }
interface QueueFile { items: QueueItem[]; schedules: LocalSchedule[] }

export class TaskQueueStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataRoot: string) { this.file = join(dataRoot, "task-queue.json"); }
  private async read(): Promise<QueueFile> { return JSON.parse(await readFile(this.file, "utf8").catch(() => '{"items":[],"schedules":[]}')) as QueueFile; }
  private async write(value: QueueFile): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2));
    await rename(temp, this.file);
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action, action); this.queue = next.then(() => undefined, () => undefined); return next; }
  async all(): Promise<QueueFile> { await this.queue; return this.read(); }
  async enqueue(taskId: string, instruction: string): Promise<QueueItem> {
    if (!instruction.trim()) throw new Error("Queue instruction is required");
    return this.mutate(async () => {
      const data = await this.read();
      const item: QueueItem = { id: randomUUID(), taskId, instruction: instruction.trim(), status: "pending", createdAt: new Date().toISOString() };
      data.items.push(item); await this.write(data); return item;
    });
  }
  async schedule(taskId: string, instruction: string, nextRunAt: string, intervalMinutes: number | null): Promise<LocalSchedule> {
    const date = new Date(nextRunAt);
    if (!instruction.trim() || !Number.isFinite(date.getTime()) || date.getTime() < Date.now() || intervalMinutes !== null && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)) throw new Error("Invalid local schedule");
    return this.mutate(async () => {
      const data = await this.read();
      const entry: LocalSchedule = { id: randomUUID(), taskId, instruction: instruction.trim(), nextRunAt: date.toISOString(), intervalMinutes, active: true, createdAt: new Date().toISOString() };
      data.schedules.push(entry); await this.write(data); return entry;
    });
  }
  async disable(id: string): Promise<void> { await this.mutate(async () => { const data = await this.read(); const item = data.schedules.find(value => value.id === id); if (!item) throw new Error("Schedule not found"); item.active = false; await this.write(data); }); }
  async advanceDue(now = new Date()): Promise<QueueItem[]> {
    return this.mutate(async () => {
      const data = await this.read();
      const queued: QueueItem[] = [];
      for (const schedule of data.schedules) {
        const due = new Date(schedule.nextRunAt).getTime();
        if (!schedule.active || due > now.getTime()) continue;
        const interval = schedule.intervalMinutes === null ? null : schedule.intervalMinutes * 60_000;
        const missedCount = interval ? Math.floor((now.getTime() - due) / interval) : 0;
        const item: QueueItem = { id: randomUUID(), taskId: schedule.taskId, instruction: schedule.instruction, status: "pending", createdAt: now.toISOString(), scheduledFor: schedule.nextRunAt, missedCount };
        data.items.push(item); queued.push(item);
        if (interval) schedule.nextRunAt = new Date(due + (missedCount + 1) * interval).toISOString();
        else schedule.active = false;
      }
      if (queued.length) await this.write(data);
      return queued;
    });
  }
  async next(): Promise<QueueItem | null> { return (await this.all()).items.find(item => item.status === "pending") ?? null; }
  async start(id: string, runId: string): Promise<void> { await this.mutate(async () => { const data = await this.read(); const item = data.items.find(value => value.id === id); if (!item || item.status !== "pending") throw new Error("Queue item is not pending"); item.status = "running"; item.runId = runId; item.startedAt = new Date().toISOString(); await this.write(data); }); }
  async finish(id: string, result: string, success: boolean): Promise<void> { await this.mutate(async () => { const data = await this.read(); const item = data.items.find(value => value.id === id); if (!item || item.status === "complete" || item.status === "failed") return; item.status = success ? "complete" : "failed"; item.result = result; item.finishedAt = new Date().toISOString(); await this.write(data); }); }
  async cancel(id: string): Promise<void> { await this.mutate(async () => { const data = await this.read(); const item = data.items.find(value => value.id === id); if (!item || item.status !== "pending") throw new Error("Queue item is not pending"); item.status = "failed"; item.result = "cancelled before start"; item.finishedAt = new Date().toISOString(); await this.write(data); }); }
  async reconcile(): Promise<void> { await this.mutate(async () => { const data = await this.read(); let changed = false; for (const item of data.items) if (item.status === "running") { item.status = "failed"; item.result = "interrupted by app shutdown; review task before retry"; item.finishedAt = new Date().toISOString(); changed = true; } if (changed) await this.write(data); }); }
}
