import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyQueueEvent, commitGlobal, foldQueue, globalLogDir, loadGlobalLog,
  type GlobalEventPlan, type GlobalLog,
} from "./global-events";

export interface QueueItem { id: string; taskId: string; instruction: string; status: "pending" | "running" | "complete" | "failed"; createdAt: string; scheduledFor?: string; missedCount?: number; runId?: string; startedAt?: string; finishedAt?: string; result?: string }
export interface LocalSchedule { id: string; taskId: string; instruction: string; intervalMinutes: number | null; nextRunAt: string; active: boolean; createdAt: string }
export interface QueueState { items: QueueItem[]; schedules: LocalSchedule[] }

/**
 * Task queue and local schedules. Since P5 every state-changing method appends to the store's event log
 * (`<dataRoot>/task-queue/events.v1.jsonl`) and rewrites `task-queue.json` from the folded state; the JSON file keeps
 * its exact shape so every existing reader works unchanged.
 */
export class TaskQueueStore {
  private readonly file: string;
  private readonly log: GlobalLog<QueueState>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataRoot: string) {
    this.file = join(dataRoot, "task-queue.json");
    this.log = { dir: globalLogDir(dataRoot, "task-queue"), origin: "queue/imported", fold: foldQueue, apply: applyQueueEvent };
  }
  /** Tolerant read: a projection written by an older build may lack fields; unknown keys survive the rewrite. */
  private async read(): Promise<QueueState> {
    const raw = await readFile(this.file, "utf8").catch(() => '{"items":[],"schedules":[]}');
    const data = JSON.parse(raw) as Partial<QueueState> & Record<string, unknown>;
    return {
      ...data,
      items: Array.isArray(data.items) ? data.items : [],
      schedules: Array.isArray(data.schedules) ? data.schedules : [],
    };
  }
  private async write(value: QueueState): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2));
    await rename(temp, this.file);
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action, action); this.queue = next.then(() => undefined, () => undefined); return next; }
  /** The folded event log; the first mutation imports a pre-event projection as the log's origin event. */
  private load(): Promise<{ state: QueueState; seq: number }> { return loadGlobalLog(this.log, () => this.read()); }
  private commit(view: { state: QueueState; seq: number }, plans: readonly GlobalEventPlan[]): Promise<void> {
    return commitGlobal(this.log, view, plans, state => this.write(state));
  }
  async all(): Promise<QueueState> { await this.queue; return this.read(); }
  async enqueue(taskId: string, instruction: string): Promise<QueueItem> {
    if (!instruction.trim()) throw new Error("Queue instruction is required");
    return this.mutate(async () => {
      const view = await this.load();
      const item: QueueItem = { id: randomUUID(), taskId, instruction: instruction.trim(), status: "pending", createdAt: new Date().toISOString() };
      await this.commit(view, [{ type: "queue-item/enqueued", payload: { item } }]);
      return item;
    });
  }
  async schedule(taskId: string, instruction: string, nextRunAt: string, intervalMinutes: number | null): Promise<LocalSchedule> {
    const date = new Date(nextRunAt);
    if (!instruction.trim() || !Number.isFinite(date.getTime()) || date.getTime() < Date.now() || intervalMinutes !== null && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)) throw new Error("Invalid local schedule");
    return this.mutate(async () => {
      const view = await this.load();
      const entry: LocalSchedule = { id: randomUUID(), taskId, instruction: instruction.trim(), nextRunAt: date.toISOString(), intervalMinutes, active: true, createdAt: new Date().toISOString() };
      await this.commit(view, [{ type: "schedule/created", payload: { schedule: entry } }]);
      return entry;
    });
  }
  async disable(id: string): Promise<void> {
    await this.mutate(async () => {
      const view = await this.load();
      if (!view.state.schedules.some(value => value.id === id)) throw new Error("Schedule not found");
      await this.commit(view, [{ type: "schedule/disabled", payload: { id } }]);
    });
  }
  async advanceDue(now = new Date()): Promise<QueueItem[]> {
    return this.mutate(async () => {
      const view = await this.load();
      const plans: GlobalEventPlan[] = [];
      const queued: QueueItem[] = [];
      for (const schedule of view.state.schedules) {
        const due = new Date(schedule.nextRunAt).getTime();
        if (!schedule.active || due > now.getTime()) continue;
        const interval = schedule.intervalMinutes === null ? null : schedule.intervalMinutes * 60_000;
        const missedCount = interval ? Math.floor((now.getTime() - due) / interval) : 0;
        const item: QueueItem = { id: randomUUID(), taskId: schedule.taskId, instruction: schedule.instruction, status: "pending", createdAt: now.toISOString(), scheduledFor: schedule.nextRunAt, missedCount };
        queued.push(item);
        plans.push({ type: "queue-item/enqueued", payload: { item } }, {
          type: "schedule/due-advanced",
          payload: { id: schedule.id, nextRunAt: interval ? new Date(due + (missedCount + 1) * interval).toISOString() : null },
        });
      }
      if (plans.length) await this.commit(view, plans);
      return queued;
    });
  }
  /** The oldest pending item, passing over items `skip` rejects (their task is busy). */
  async next(skip: (item: QueueItem) => boolean = () => false): Promise<QueueItem | null> { return (await this.all()).items.find(item => item.status === "pending" && !skip(item)) ?? null; }
  async start(id: string, runId: string): Promise<void> {
    await this.mutate(async () => {
      const view = await this.load();
      const item = view.state.items.find(value => value.id === id);
      if (!item || item.status !== "pending") throw new Error("Queue item is not pending");
      await this.commit(view, [{ type: "queue-item/started", payload: { id, runId, startedAt: new Date().toISOString() } }]);
    });
  }
  async finish(id: string, result: string, success: boolean): Promise<void> {
    await this.mutate(async () => {
      const view = await this.load();
      const item = view.state.items.find(value => value.id === id);
      if (!item || item.status === "complete" || item.status === "failed") return;
      await this.commit(view, [{ type: "queue-item/finished", payload: { id, status: success ? "complete" : "failed", result, finishedAt: new Date().toISOString() } }]);
    });
  }
  async cancel(id: string): Promise<void> {
    await this.mutate(async () => {
      const view = await this.load();
      const item = view.state.items.find(value => value.id === id);
      if (!item || item.status !== "pending") throw new Error("Queue item is not pending");
      await this.commit(view, [{ type: "queue-item/cancelled", payload: { id, result: "cancelled before start", finishedAt: new Date().toISOString() } }]);
    });
  }
  async reconcile(): Promise<void> {
    await this.mutate(async () => {
      const view = await this.load();
      const plans = view.state.items.filter(item => item.status === "running").map(item => ({
        type: "queue-item/finished" as const,
        payload: { id: item.id, status: "failed" as const, result: "interrupted by app shutdown; review task before retry", finishedAt: new Date().toISOString() },
      }));
      if (plans.length) await this.commit(view, plans);
    });
  }
}
