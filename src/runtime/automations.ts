import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAllowedModelSelector } from "./model-policy";

export type AutomationSchedule = { kind: "once"; at: string } | { kind: "rrule"; rule: string; timeZone: string; startAt: string };
export interface Automation {
  id: string;
  name: string;
  prompt: string;
  kind: "cron" | "heartbeat";
  status: "ACTIVE" | "PAUSED";
  schedule: AutomationSchedule;
  nextRunAt: string | null;
  modelSelector: string | null;
  executor?: "scoped-git-backup";
  projectId?: string;
  mountId?: string;
  targetTaskId?: string;
  notificationPolicy: "all" | "failures";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
export interface AutomationRun {
  id: string;
  automationId: string;
  dueAt: string;
  status: "pending" | "running" | "complete" | "failed" | "needs-input" | "skipped";
  missedCount: number;
  taskId?: string;
  operationId?: string;
  result?: string;
  startedAt?: string;
  finishedAt?: string;
  readAt?: string;
}
export type AutomationState = { automations: Automation[]; runs: AutomationRun[] };
export type AutomationInput = Pick<Automation, "name" | "prompt" | "kind" | "schedule" | "modelSelector" | "notificationPolicy"> & Partial<Pick<Automation, "projectId" | "mountId" | "targetTaskId" | "executor">>;
type Frequency = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY";
type Rule = { frequency: Frequency; interval: number; hour?: number; minute?: number; days?: number[] };
const dayNames = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const minute = 60_000;
const day = 86_400_000;
const catchUpWindow = day;

function parseRule(value: string): Rule {
  const entries = value.split(";").map(part => part.split("="));
  if (entries.some(part => part.length !== 2) || new Set(entries.map(part => part[0])).size !== entries.length) throw new Error("Invalid RRULE");
  const fields = Object.fromEntries(entries) as Record<string, string>;
  if (Object.keys(fields).some(key => !["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"].includes(key))) throw new Error("Unsupported RRULE field");
  const frequency = fields.FREQ as Frequency;
  if (!["MINUTELY", "HOURLY", "DAILY", "WEEKLY"].includes(frequency)) throw new Error("Unsupported RRULE frequency");
  const interval = fields.INTERVAL === undefined ? 1 : Number(fields.INTERVAL);
  const maximum = frequency === "MINUTELY" ? 1440 : frequency === "HOURLY" ? 24 : frequency === "DAILY" ? 31 : 4;
  if (!Number.isInteger(interval) || interval < 1 || interval > maximum) throw new Error("Invalid RRULE interval");
  const hour = fields.BYHOUR === undefined ? undefined : Number(fields.BYHOUR);
  const minuteValue = fields.BYMINUTE === undefined ? undefined : Number(fields.BYMINUTE);
  if (hour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23) || minuteValue !== undefined && (!Number.isInteger(minuteValue) || minuteValue < 0 || minuteValue > 59)) throw new Error("Invalid RRULE time");
  if (fields.BYDAY && frequency !== "WEEKLY") throw new Error("BYDAY requires a weekly rule");
  if (frequency === "MINUTELY" && (hour !== undefined || minuteValue !== undefined) || frequency === "HOURLY" && hour !== undefined) throw new Error("Unsupported RRULE time field");
  const days = fields.BYDAY?.split(",").map(name => dayNames.indexOf(name));
  if (days?.some(value => value < 0) || fields.BYDAY === "") throw new Error("Invalid RRULE weekday");
  return { frequency, interval, hour, minute: minuteValue, days };
}

function localParts(formatter: Intl.DateTimeFormat, time: number) {
  const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
  const ordinal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / day;
  return { ordinal, weekday: dayNames.indexOf(parts.weekday!.slice(0, 2).toUpperCase()), hour: Number(parts.hour), minute: Number(parts.minute) };
}

function repeatedWallMinute(formatter: Intl.DateTimeFormat, time: number, local: ReturnType<typeof localParts>): boolean {
  for (let offset = 1; offset <= 180; offset++) {
    const prior = localParts(formatter, time - offset * minute);
    if (prior.ordinal === local.ordinal && prior.hour === local.hour && prior.minute === local.minute) return true;
  }
  return false;
}

/** RRULE subset used by the local Codex and WorkBuddy examples; evaluate wall time in its saved time zone. */
export function nextAutomationTime(schedule: AutomationSchedule, after: Date): string | null {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid one-time schedule");
    return at.getTime() > after.getTime() ? at.toISOString() : null;
  }
  const anchor = new Date(schedule.startAt);
  if (!Number.isFinite(anchor.getTime())) throw new Error("Invalid RRULE start time");
  const rule = parseRule(schedule.rule);
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatter.format(anchor); }
  catch { throw new Error("Invalid schedule time zone"); }
  const origin = localParts(formatter, anchor.getTime());
  const start = Math.ceil(Math.max(after.getTime() + 1, anchor.getTime()) / minute) * minute;
  if (rule.frequency === "MINUTELY") {
    const originMinute = Math.ceil(anchor.getTime() / minute) * minute;
    const steps = Math.ceil((start - originMinute) / (rule.interval * minute));
    return new Date(originMinute + Math.max(0, steps) * rule.interval * minute).toISOString();
  }
  const limit = start + 35 * day;
  for (let time = start; time <= limit; time += minute) {
    const local = localParts(formatter, time);
    const sameMinute = local.minute === (rule.minute ?? origin.minute);
    if (rule.frequency === "HOURLY" && sameMinute && ((local.ordinal - origin.ordinal) * 24 + local.hour - origin.hour) % rule.interval === 0) return new Date(time).toISOString();
    if (rule.frequency === "DAILY" && sameMinute && local.hour === (rule.hour ?? origin.hour) && (local.ordinal - origin.ordinal) % rule.interval === 0 && !repeatedWallMinute(formatter, time, local)) return new Date(time).toISOString();
    if (rule.frequency === "WEEKLY" && sameMinute && local.hour === (rule.hour ?? origin.hour) && (rule.days ?? [origin.weekday]).includes(local.weekday) && Math.floor((local.ordinal - local.weekday - origin.ordinal + origin.weekday) / 7) % rule.interval === 0 && !repeatedWallMinute(formatter, time, local)) return new Date(time).toISOString();
  }
  throw new Error("RRULE has no occurrence within 35 days");
}

function checked(input: AutomationInput): AutomationInput {
  const name = input.name?.trim();
  const prompt = input.prompt?.trim();
  if (!name || name.length > 100 || !prompt || prompt.length > 20_000) throw new Error("Automation name and prompt are required");
  if (input.kind !== "cron" && input.kind !== "heartbeat" || input.kind === "heartbeat" && !input.targetTaskId || input.kind === "cron" && input.targetTaskId) throw new Error("Invalid automation target");
  if (input.mountId && !input.projectId || input.kind === "heartbeat" && (input.projectId || input.mountId)) throw new Error("Invalid automation project");
  for (const id of [input.projectId, input.mountId, input.targetTaskId]) if (id !== undefined && typeof id !== "string") throw new Error("Invalid automation identifier");
  if (input.modelSelector !== null && !isAllowedModelSelector(input.modelSelector)) throw new Error("Unsupported automation model");
  if (input.executor && (input.executor !== "scoped-git-backup" || input.kind !== "cron" || !input.projectId || !input.mountId || input.modelSelector !== null)) throw new Error("Invalid scoped backup automation");
  if (input.notificationPolicy !== "all" && input.notificationPolicy !== "failures") throw new Error("Invalid notification policy");
  if (input.schedule.kind !== "once" && input.schedule.kind !== "rrule") throw new Error("Invalid automation schedule");
  nextAutomationTime(input.schedule, new Date(0));
  return { name, prompt, kind: input.kind, schedule: input.schedule, modelSelector: input.modelSelector, notificationPolicy: input.notificationPolicy,
    ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.mountId ? { mountId: input.mountId } : {}), ...(input.targetTaskId ? { targetTaskId: input.targetTaskId } : {}), ...(input.executor ? { executor: input.executor } : {}) };
}

export class AutomationStore {
  private readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(dataRoot: string) { this.file = join(dataRoot, "automations.json"); }
  private async read(): Promise<AutomationState> {
    const raw = await readFile(this.file, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return '{"automations":[],"runs":[]}'; throw error; });
    const data = JSON.parse(raw) as AutomationState;
    if (!Array.isArray(data.automations) || !Array.isArray(data.runs)) throw new Error("Automation store is invalid");
    return data;
  }
  private async write(data: AutomationState): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2));
    await rename(temp, this.file);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.pending.then(work); this.pending = result.then(() => undefined, () => undefined); return result; }
  list(): Promise<AutomationState> { return this.serial(async () => { const data = await this.read(); return { automations: data.automations.filter(item => !item.deletedAt), runs: data.runs }; }); }
  async create(input: AutomationInput, status: Automation["status"] = "ACTIVE"): Promise<Automation> {
    if (status !== "ACTIVE" && status !== "PAUSED") throw new Error("Invalid automation status");
    const value = checked(input);
    return this.serial(async () => {
      const data = await this.read();
      const now = new Date().toISOString();
      const nextRunAt = nextAutomationTime(value.schedule, new Date(Date.now() - 1));
      if (!nextRunAt) throw new Error("Schedule has no future occurrence");
      const automation: Automation = { ...value, id: randomUUID(), status, nextRunAt, createdAt: now, updatedAt: now };
      data.automations.push(automation); await this.write(data); return automation;
    });
  }
  async update(id: string, patch: Partial<AutomationInput> & { status?: Automation["status"] }): Promise<Automation> {
    return this.serial(async () => {
      const data = await this.read();
      const item = data.automations.find(value => value.id === id && !value.deletedAt);
      if (!item) throw new Error("Automation not found");
      if (patch.status && patch.status !== "ACTIVE" && patch.status !== "PAUSED") throw new Error("Invalid automation status");
      const fields = ["name", "prompt", "kind", "schedule", "modelSelector", "notificationPolicy", "projectId", "mountId", "targetTaskId", "executor"] as const;
      const supplied = Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(patch, key)).map(key => [key, patch[key]]));
      const candidate = { ...item, ...supplied };
      if (candidate.kind === "cron") delete candidate.targetTaskId;
      else { delete candidate.projectId; delete candidate.mountId; }
      const next = checked(candidate);
      const wasPaused = item.status === "PAUSED";
      Object.assign(item, next, { status: patch.status ?? item.status, updatedAt: new Date().toISOString() });
      if (item.kind === "cron") delete item.targetTaskId;
      else { delete item.projectId; delete item.mountId; }
      if (patch.schedule || patch.status === "ACTIVE" && wasPaused) item.nextRunAt = nextAutomationTime(item.schedule, new Date(Date.now() - 1));
      if (item.status === "ACTIVE" && !item.nextRunAt) item.nextRunAt = nextAutomationTime(item.schedule, new Date(Date.now() - 1));
      await this.write(data); return item;
    });
  }
  async delete(id: string): Promise<void> { await this.serial(async () => { const data = await this.read(); const item = data.automations.find(value => value.id === id && !value.deletedAt); if (!item) throw new Error("Automation not found"); item.status = "PAUSED"; item.deletedAt = new Date().toISOString(); await this.write(data); }); }
  async runNow(id: string): Promise<AutomationRun> { return this.serial(async () => { const data = await this.read(); const item = data.automations.find(value => value.id === id && !value.deletedAt); if (!item || item.status !== "ACTIVE") throw new Error("Automation is not active"); if (data.runs.some(run => run.automationId === id && ["pending", "running"].includes(run.status))) throw new Error("Automation already has a pending run"); const run: AutomationRun = { id: randomUUID(), automationId: id, dueAt: new Date().toISOString(), status: "pending", missedCount: 0 }; data.runs.push(run); await this.write(data); return run; }); }
  async advanceDue(now = new Date()): Promise<AutomationRun[]> {
    return this.serial(async () => {
      const data = await this.read(); const due: AutomationRun[] = []; let changed = false;
      for (const item of data.automations) {
        if (item.deletedAt || item.status !== "ACTIVE" || !item.nextRunAt || new Date(item.nextRunAt).getTime() > now.getTime()) continue;
        const at = item.nextRunAt;
        let next = item.schedule.kind === "once" ? null : nextAutomationTime(item.schedule, now);
        let missedCount = 0;
        if (item.schedule.kind === "rrule") {
          let cursor = at;
          while (missedCount < 1440) { const following = nextAutomationTime(item.schedule, new Date(cursor)); if (!following || new Date(following).getTime() > now.getTime()) break; missedCount++; cursor = following; }
        }
        item.nextRunAt = next;
        changed = true;
        if (data.runs.some(run => run.automationId === item.id && ["pending", "running"].includes(run.status))) continue;
        const expired = now.getTime() - new Date(at).getTime() > catchUpWindow;
        const run: AutomationRun = { id: randomUUID(), automationId: item.id, dueAt: at, status: expired ? "skipped" : "pending", missedCount, ...(expired ? { result: "Missed the 24-hour catch-up window", finishedAt: now.toISOString() } : {}) };
        data.runs.push(run); if (!expired) due.push(run);
      }
      if (changed) await this.write(data);
      return due;
    });
  }
  /** The oldest pending run, passing over runs `skip` rejects (they would follow a busy task). */
  next(skip: (run: AutomationRun, automation: Automation | undefined) => boolean = () => false): Promise<AutomationRun | null> { return this.serial(async () => { const data = await this.read(); return data.runs.find(run => run.status === "pending" && !skip(run, data.automations.find(item => item.id === run.automationId))) ?? null; }); }
  async start(id: string, taskId: string, operationId: string): Promise<void> { await this.serial(async () => { const data = await this.read(); const run = data.runs.find(item => item.id === id); if (!run || run.status !== "pending") throw new Error("Automation run is not pending"); Object.assign(run, { status: "running", taskId, operationId, startedAt: new Date().toISOString() }); await this.write(data); }); }
  async finish(id: string, status: "complete" | "failed" | "needs-input", result: string): Promise<void> { await this.serial(async () => { const data = await this.read(); const run = data.runs.find(item => item.id === id); if (!run || !["pending", "running"].includes(run.status)) return; Object.assign(run, { status, result, finishedAt: new Date().toISOString() }); await this.write(data); }); }
  async markRead(id: string): Promise<void> { await this.serial(async () => { const data = await this.read(); const run = data.runs.find(item => item.id === id); if (!run) throw new Error("Automation run not found"); run.readAt = new Date().toISOString(); await this.write(data); }); }
  async reconcile(): Promise<void> { await this.serial(async () => { const data = await this.read(); let changed = false; for (const run of data.runs) if (run.status === "running") { Object.assign(run, { status: "failed", result: "Interrupted by app shutdown; inspect the task before retry", finishedAt: new Date().toISOString() }); changed = true; } if (changed) await this.write(data); }); }
}
