import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Alpha 定时任务：轻量调度器。sidecar 持有计划表，到点把提示词投递给指定会话（或新建会话）。
 * 纯调度逻辑与投递解耦：deliver 注入真实投递，测试注入桩。不依赖 OMP 内核改动。
 */

export interface ScheduleTarget {
  /** session = 投递给已有会话（进程未开则由投递方拉起）；new = 到点新建会话。 */
  kind: "session" | "new";
  sessionId?: string;
  cwd?: string;
}

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  /** interval = 每隔 N 分钟；cron = 标准 5 段表达式（分 时 日 月 周）。 */
  kind: "interval" | "cron";
  intervalMinutes?: number;
  cron?: string;
  target: ScheduleTarget;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus?: "running" | "completed" | "failed" | "aborted" | "interrupted";
  lastSessionId?: string;
}

export interface ScheduleInput {
  name?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  kind?: unknown;
  intervalMinutes?: unknown;
  cron?: unknown;
  target?: unknown;
}

const CRON_FIELD = /^(\*|\d+)(?:(?:-\d+)?(?:\/\d+)?)?(?:,(\*|\d+)(?:(?:-\d+)?(?:\/\d+)?)?)*$/;

function parseField(field: string, min: number, max: number): Set<number> | null {
  if (!CRON_FIELD.test(field)) return null;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    const [startText, endText] = range.split("-");
    const start = startText === "*" ? min : Number(startText);
    const end = endText === undefined ? (startText === "*" || stepText !== undefined ? max : start) : Number(endText);
    if (start < min || end > max || start > end) return null;
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}

/** Local-time cron: Sunday is 0/7; restricted day-of-month and weekday use OR. */
export function nextCronRun(expr: string, from: Date): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || !Number.isFinite(from.getTime())) return null;
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const parsed = fields.map((field, i) => parseField(field, bounds[i][0], bounds[i][1]));
  if (parsed.some(field => !field)) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as Set<number>[];
  if (dayOfWeek.has(7)) dayOfWeek.add(0);
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const end = new Date(cursor); end.setFullYear(end.getFullYear() + 8);
  while (cursor < end) {
    const dom = dayOfMonth.has(cursor.getDate());
    const dow = dayOfWeek.has(cursor.getDay());
    const day = fields[2].startsWith("*") || fields[4].startsWith("*") ? dom && dow : dom || dow;
    if (!month.has(cursor.getMonth() + 1) || !day) { cursor.setDate(cursor.getDate() + 1); cursor.setHours(0, 0, 0, 0); continue; }
    if (!hour.has(cursor.getHours())) { cursor.setHours(cursor.getHours() + 1, 0, 0, 0); continue; }
    if (minute.has(cursor.getMinutes())) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function computeNextRun(schedule: Pick<Schedule, "kind" | "intervalMinutes" | "cron">, from: Date): Date | null {
  if (schedule.kind === "interval") {
    const minutes = schedule.intervalMinutes;
    return Number.isInteger(minutes) && (minutes ?? 0) >= 1 ? new Date(from.getTime() + (minutes as number) * 60_000) : null;
  }
  return schedule.cron ? nextCronRun(schedule.cron, from) : null;
}

function normalize(input: ScheduleInput, previous?: Schedule): { value: Omit<Schedule, "nextRunAt" | "lastRunAt" | "lastResult">; error?: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!name || name.length > 120) return { value: null as never, error: "名称需要 1–120 个字符" };
  if (!prompt || prompt.length > 20_000) return { value: null as never, error: "提示词需要 1–20000 个字符" };
  const kind = input.kind === "cron" ? "cron" : input.kind === "interval" ? "interval" : null;
  if (!kind) return { value: null as never, error: "计划类型需要是 interval 或 cron" };
  const intervalMinutes = input.intervalMinutes === undefined ? previous?.intervalMinutes : Number(input.intervalMinutes);
  const cron = input.cron === undefined ? previous?.cron : typeof input.cron === "string" ? input.cron.trim() : undefined;
  if (kind === "interval" && (!Number.isInteger(intervalMinutes) || (intervalMinutes ?? 0) < 1)) return { value: null as never, error: "间隔需要是 ≥1 的整数分钟" };
  if (kind === "cron" && (typeof cron !== "string" || !nextCronRun(cron, new Date()))) return { value: null as never, error: "cron 表达式需要是有效的标准 5 段格式" };
  const rawTarget = input.target ?? previous?.target ?? { kind: "new" };
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) return { value: null as never, error: "目标类型无效" };
  const target = rawTarget as ScheduleTarget;
  if (target.kind === "session") {
    if (typeof target.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(target.sessionId)) return { value: null as never, error: "目标会话 ID 无效" };
  } else if (target.kind !== "new") {
    return { value: null as never, error: "目标类型需要是 session 或 new" };
  }
  return {
    value: {
      id: previous?.id ?? randomUUID(),
      name, prompt,
      enabled: input.enabled === undefined ? previous?.enabled ?? true : input.enabled === true,
      kind,
      ...(kind === "interval" ? { intervalMinutes: intervalMinutes as number } : { cron: cron as string }),
      target,
    },
  };
}

/** 计划表持久化：`<dataRoot>/native/schedules.json`。 */
export class ScheduleStore {
  readonly file: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string) {
    this.file = join(dataRoot, "native", "schedules.json");
  }

  async list(): Promise<Schedule[]> {
    await this.#queue;
    return this.#read();
  }

  async #read(): Promise<Schedule[]> {
    const parsed: unknown = await readFile(this.file, "utf8").then(text => JSON.parse(text), () => []);
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === "object") as Schedule[] : [];
  }

  async create(input: ScheduleInput, now = new Date()): Promise<Schedule> {
    const { value, error } = normalize(input);
    if (error) throw new Error(error);
    const schedule: Schedule = { ...value, nextRunAt: computeNextRun(value, now)?.toISOString() ?? null, lastRunAt: null, lastResult: null };
    return this.#mutate(items => { items.push(schedule); return schedule; });
  }

  async update(id: string, input: ScheduleInput, now = new Date()): Promise<Schedule> {
    return this.#mutate(items => {
      const index = items.findIndex(item => item.id === id);
      if (index < 0) throw new Error("定时任务不存在");
      const previous = items[index];
      const { value, error } = normalize({ ...input, name: input.name ?? previous.name, prompt: input.prompt ?? previous.prompt, kind: input.kind ?? previous.kind }, previous);
      if (error) throw new Error(error);
      const schedule: Schedule = { ...previous, ...value, nextRunAt: computeNextRun(value, now)?.toISOString() ?? null };
      items[index] = schedule;
      return schedule;
    });
  }

  async remove(id: string): Promise<void> {
    await this.#mutate(items => { const index = items.findIndex(item => item.id === id); if (index >= 0) items.splice(index, 1); });
  }

  /** 运行回执：到点触发后写 lastRun/lastResult 并排下一次。 */
  async recordRun(id: string, result: string, now = new Date(), status: Schedule["lastStatus"] = "completed"): Promise<void> {
    await this.#mutate(items => {
      const index = items.findIndex(item => item.id === id);
      if (index < 0) return;
      const schedule = items[index];
      schedule.lastRunAt = now.toISOString();
      schedule.lastResult = result.slice(0, 500);
      schedule.lastStatus = status;
      schedule.nextRunAt = (schedule.enabled ? computeNextRun(schedule, now)?.toISOString() : null) ?? null;
      items[index] = schedule;
    });
  }

  async beginRun(id: string, now: Date, sessionId?: string): Promise<void> {
    await this.#mutate(items => {
      const item = items.find(item => item.id === id);
      if (!item) return;
      item.lastStatus = "running";
      item.lastRunAt = now.toISOString();
      item.lastResult = "执行中";
      item.nextRunAt = null;
      if (sessionId) item.lastSessionId = sessionId;
    });
  }

  async recoverInterrupted(now = new Date()): Promise<void> {
    for (const item of await this.list()) if (item.lastStatus === "running") {
      await this.recordRun(item.id, "中断：Alpha 上次退出时任务尚未完成", now, "interrupted");
    }
  }

  async #mutate<T>(change: (items: Schedule[]) => T): Promise<T> {
    const operation = this.#queue.then(async () => {
      const items = await this.#read();
      const result = change(items);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(items, null, 2)}\n`, "utf8");
      await rename(temp, this.file);
      return result;
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}

export type ScheduleDeliver = (schedule: Schedule) => Promise<string | { result: string; status: Schedule["lastStatus"] }>;

/**
 * 调度循环：每次 tick 找出到点的启用计划并投递。同一计划上一次未完成时跳过本次（不叠加）。
 */
export class Scheduler {
  #timer: NodeJS.Timeout | undefined;
  #running = new Set<string>();

  constructor(private readonly store: ScheduleStore, private readonly deliver: ScheduleDeliver, private readonly now: () => Date = () => new Date()) {}

  start(intervalMs = 20_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    const now = this.now();
    for (const schedule of await this.store.list()) {
      if (!schedule.enabled || !schedule.nextRunAt || this.#running.has(schedule.id)) continue;
      if (new Date(schedule.nextRunAt).getTime() > now.getTime()) continue;
      this.#running.add(schedule.id);
      try {
        await this.store.beginRun(schedule.id, now);
        const result = await this.deliver(schedule);
        await this.store.recordRun(schedule.id, typeof result === "string" ? result : result.result, this.now(), typeof result === "string" ? "completed" : result.status);
      } catch (error) {
        await this.store.recordRun(schedule.id, `失败：${error instanceof Error ? error.message : String(error)}`, this.now(), "failed");
      } finally {
        this.#running.delete(schedule.id);
      }
    }
  }
}
