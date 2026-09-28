import { join } from "node:path";
import type { Automation, AutomationRun, AutomationState } from "./automations";
import type { LocalSchedule, QueueItem, QueueState } from "./task-queue";
import {
  EventConflictError, InvariantError, appendEvent, appendPlannedEvent, readEvents, taskLogDir,
  type LoggedEvent,
} from "./task-events";
import type { TaskActor } from "./task-events";

/**
 * Event envelope and log wrapper for the two GLOBAL stores (docs/cognitive-state-machine-plan-2026-09-28.md §5 P5:
 * queue and automations stay independent of the task logs, but become events + projection like P1 did for ledgers).
 * The envelope is the same `{ seq, at, actor, runId?, type, payload }` the task log uses, so `appendEvent`,
 * `appendPlannedEvent` and `readEvents` from `task-events/log.ts` apply unchanged; the events just live at
 * `<dataRoot>/task-queue/events.v1.jsonl` and `<dataRoot>/automations/events.v1.jsonl`, beside their projections
 * (`task-queue.json`, `automations.json`).
 *
 * Payloads carry exactly what the stores persist: generated ids, timestamps and computed values are produced by the
 * store method and travel in the payload, so the reducers never touch a clock, mint an id or read a file and a fold
 * reproduces the projection byte for byte. The only values a reducer writes that the payload does not carry are the
 * outcomes an event type fixes by definition: a started item/run is `running`, a cancelled item is persisted `failed`,
 * a disabled schedule is `active: false`, a due advance with no next occurrence deactivates the schedule, and a
 * deleted automation is persisted `PAUSED` — the same rules the store code applied.
 */

export interface GlobalEventPayloads {
  /** The log's origin, written once the first time a store with a pre-event projection is touched. */
  "queue/imported": { state: QueueState; source: "legacy-json" };
  "queue-item/enqueued": { item: QueueItem };
  "queue-item/started": { id: string; runId: string; startedAt: string };
  "queue-item/finished": { id: string; status: "complete" | "failed"; result: string; finishedAt: string };
  "queue-item/cancelled": { id: string; result: string; finishedAt: string };
  "schedule/created": { schedule: LocalSchedule };
  "schedule/disabled": { id: string };
  /** `nextRunAt: null` is a one-shot schedule that fired: it keeps its occurrence but deactivates. */
  "schedule/due-advanced": { id: string; nextRunAt: string | null };

  /** The log's origin, written once the first time a store with a pre-event projection is touched. */
  "automation/imported": { state: AutomationState; source: "legacy-json" };
  "automation/created": { automation: Automation };
  /** The persisted record after a rewrite (create-time fields, `updatedAt`, recomputed `nextRunAt`). */
  "automation/updated": { automation: Automation };
  "automation/deleted": { id: string; deletedAt: string };
  "automation/status-changed": { id: string; status: "ACTIVE" | "PAUSED"; updatedAt: string; nextRunAt: string | null };
  "automation-run/queued": { run: AutomationRun };
  "automation-run/started": { id: string; taskId: string; operationId: string; startedAt: string };
  "automation-run/finished": { id: string; status: "complete" | "failed" | "needs-input"; result: string; finishedAt: string };
  "automation-run/read": { id: string; readAt: string };
}

export type GlobalEventType = keyof GlobalEventPayloads;
/** The one event type each global log starts with. */
export type GlobalOriginType = Extract<GlobalEventType, "queue/imported" | "automation/imported">;

export type GlobalEventOf<Type extends GlobalEventType> = {
  seq: number;
  at: string;
  actor: TaskActor;
  runId?: string;
  type: Type;
  payload: GlobalEventPayloads[Type];
};

export type GlobalEvent = { [Type in GlobalEventType]: GlobalEventOf<Type> }[GlobalEventType];

/** An event as a store builds it, before the log assigns `seq`; distributes so the type stays discriminated. */
export type GlobalEventDraft<Type extends GlobalEventType = GlobalEventType> =
  Type extends GlobalEventType ? Omit<GlobalEventOf<Type>, "seq"> : never;

/** What a store method hands to `commitGlobal`; the log stamps `seq` and `at`. */
export type GlobalEventPlan = { [Type in GlobalEventType]: { type: Type; payload: GlobalEventPayloads[Type] } }[GlobalEventType];

/** Replaces a record's contents in place, keeping the replacement's key order so the projection stays byte-identical. */
function replaceRecord<T extends object>(target: T, next: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) if (!(key in next)) delete target[key];
  Object.assign(target, next);
}

// ── task-queue store ────────────────────────────────────────────────────────────────────────────────────────────────

function pendingItem(state: QueueState, id: string): QueueItem {
  const item = state.items.find(value => value.id === id);
  if (!item || item.status !== "pending") throw new InvariantError("apply/queue-item-not-pending", "Queue item is not pending");
  return item;
}

function queueSchedule(state: QueueState, id: string): LocalSchedule {
  const schedule = state.schedules.find(value => value.id === id);
  if (!schedule) throw new InvariantError("apply/schedule-not-found", "Schedule not found");
  return schedule;
}

/** One queue reducer family; only `queue/*` and `queue-item/*`, `schedule/*` events may reach a queue log. */
export function applyQueueEvent(state: QueueState, event: GlobalEvent): void {
  switch (event.type) {
    case "queue/imported": return replaceRecord(state, event.payload.state);
    case "queue-item/enqueued": return void state.items.push(event.payload.item);
    case "queue-item/started": {
      const item = pendingItem(state, event.payload.id);
      item.status = "running";
      item.runId = event.payload.runId;
      item.startedAt = event.payload.startedAt;
      return;
    }
    case "queue-item/finished": {
      const item = state.items.find(value => value.id === event.payload.id);
      // `finish` is idempotent: the store silently returns on an absent or ended item, so the fold does too.
      if (!item || item.status === "complete" || item.status === "failed") return;
      item.status = event.payload.status;
      item.result = event.payload.result;
      item.finishedAt = event.payload.finishedAt;
      return;
    }
    case "queue-item/cancelled": {
      const item = pendingItem(state, event.payload.id);
      // A cancelled item is persisted as failed with its reason, exactly as `cancel` always wrote it.
      item.status = "failed";
      item.result = event.payload.result;
      item.finishedAt = event.payload.finishedAt;
      return;
    }
    case "schedule/created": return void state.schedules.push(event.payload.schedule);
    case "schedule/disabled": return void (queueSchedule(state, event.payload.id).active = false);
    case "schedule/due-advanced": {
      const schedule = queueSchedule(state, event.payload.id);
      if (event.payload.nextRunAt) schedule.nextRunAt = event.payload.nextRunAt;
      else schedule.active = false;
      return;
    }
    default: throw new InvariantError("fold/unknown-event", `No reducer for event type ${event.type}`);
  }
}

// ── automations store ───────────────────────────────────────────────────────────────────────────────────────────────

function automationOrThrow(state: AutomationState, id: string): Automation {
  const item = state.automations.find(value => value.id === id);
  if (!item) throw new InvariantError("apply/automation-not-found", "Automation not found");
  return item;
}

function startedRun(state: AutomationState, id: string): AutomationRun {
  const run = state.runs.find(value => value.id === id);
  if (!run || run.status !== "pending") throw new InvariantError("apply/automation-run-not-pending", "Automation run is not pending");
  return run;
}

function runOrThrow(state: AutomationState, id: string): AutomationRun {
  const run = state.runs.find(value => value.id === id);
  if (!run) throw new InvariantError("apply/automation-run-not-found", "Automation run not found");
  return run;
}

/** One automations reducer family; only `automation/*` and `automation-run/*` events may reach an automations log. */
export function applyAutomationEvent(state: AutomationState, event: GlobalEvent): void {
  switch (event.type) {
    case "automation/imported": return replaceRecord(state, event.payload.state);
    case "automation/created": return void state.automations.push(event.payload.automation);
    case "automation/updated": return void replaceRecord(automationOrThrow(state, event.payload.automation.id), event.payload.automation);
    case "automation/deleted": {
      const item = automationOrThrow(state, event.payload.id);
      // Deletion is a soft delete that pauses, exactly as `delete` always wrote it.
      item.status = "PAUSED";
      item.deletedAt = event.payload.deletedAt;
      return;
    }
    case "automation/status-changed": {
      const item = automationOrThrow(state, event.payload.id);
      item.status = event.payload.status;
      item.updatedAt = event.payload.updatedAt;
      item.nextRunAt = event.payload.nextRunAt;
      return;
    }
    case "automation-run/queued": return void state.runs.push(event.payload.run);
    case "automation-run/started": {
      const run = startedRun(state, event.payload.id);
      run.status = "running";
      run.taskId = event.payload.taskId;
      run.operationId = event.payload.operationId;
      run.startedAt = event.payload.startedAt;
      return;
    }
    case "automation-run/finished": {
      const run = state.runs.find(value => value.id === event.payload.id);
      // `finish` is idempotent: the store silently returns on an absent or ended run, so the fold does too.
      if (!run || !["pending", "running"].includes(run.status)) return;
      run.status = event.payload.status;
      run.result = event.payload.result;
      run.finishedAt = event.payload.finishedAt;
      return;
    }
    case "automation-run/read": return void (runOrThrow(state, event.payload.id).readAt = event.payload.readAt);
    default: throw new InvariantError("fold/unknown-event", `No reducer for event type ${event.type}`);
  }
}

// ── folds ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The only way a global store state comes into existence: strict on sequence continuity and on the origin event, the
 * way `foldTask` is for task ledgers. Global stores have no transition table — every record transition their events
 * cause was legal before the event log existed.
 */
function foldStore<S>(events: readonly GlobalEvent[], origin: GlobalOriginType, apply: (state: S, event: GlobalEvent) => void): S {
  const state = {} as S;
  let expectedSeq = 0;
  for (const event of events) {
    expectedSeq += 1;
    if (event.seq !== expectedSeq) throw new InvariantError("fold/seq-gap", `Expected seq ${expectedSeq}, found ${event.seq}`);
    if (expectedSeq === 1) {
      if (event.type !== origin) throw new InvariantError("fold/missing-origin", `Log starts with ${event.type} instead of ${origin}`);
    } else if (event.type === origin) {
      throw new InvariantError("fold/duplicate-origin", `${event.type} appears at seq ${event.seq}`);
    }
    apply(state, event);
  }
  if (!expectedSeq) throw new InvariantError("fold/empty-log", "A global event log needs an origin event");
  return state;
}

export function foldQueue(events: readonly GlobalEvent[]): QueueState {
  return foldStore<QueueState>(events, "queue/imported", applyQueueEvent);
}

export function foldAutomations(events: readonly GlobalEvent[]): AutomationState {
  return foldStore<AutomationState>(events, "automation/imported", applyAutomationEvent);
}

// ── log wrapper (task-events/log.ts primitives) ─────────────────────────────────────────────────────────────────────

export type GlobalStoreName = "task-queue" | "automations";

/** `<dataRoot>/<store>/events.v1.jsonl`, derived from the `<store>.json` projection the way a task's log is. */
export function globalLogDir(dataRoot: string, store: GlobalStoreName): string {
  return taskLogDir(join(dataRoot, `${store}.json`));
}

export function readGlobalEvents(dir: string): Promise<GlobalEvent[]> {
  return readEvents<GlobalEvent>(dir);
}

export function appendGlobalEvent<E extends GlobalEventDraft>(
  dir: string,
  draft: E,
  expectedSeq: number,
  afterAppend?: (event: LoggedEvent<E>) => Promise<void>,
): Promise<LoggedEvent<E>> {
  return appendEvent(dir, draft, expectedSeq, afterAppend);
}

/** `appendPlannedEvent` for one global event: planning runs inside the log lock, and a stale writer re-plans. */
export function planGlobalEvent<E extends GlobalEventDraft>(
  dir: string,
  expectedSeq: number,
  plan: () => Promise<E | null>,
  onStale: () => Promise<number>,
  afterAppend?: (event: LoggedEvent<E>) => Promise<void>,
): Promise<LoggedEvent<E> | null> {
  return appendPlannedEvent(dir, expectedSeq, plan, onStale, afterAppend);
}

/** One store's log: where it lives, which event opens it, and how its state folds. */
export interface GlobalLog<S> {
  dir: string;
  origin: GlobalOriginType;
  fold: (events: readonly GlobalEvent[]) => S;
  apply: (state: S, event: GlobalEvent) => void;
}

export interface GlobalLogView<S> {
  state: S;
  /** Sequence number the log ends at; appends are compare-and-swap against it. */
  seq: number;
}

/**
 * The folded log. A projection written before the event log existed is imported once as the log's origin event,
 * leaving the original file untouched; a second writer that raced the import joins the winner's log instead of
 * appending a second origin.
 */
export async function loadGlobalLog<S>(log: GlobalLog<S>, projection: () => Promise<S>): Promise<GlobalLogView<S>> {
  const events = await readGlobalEvents(log.dir);
  if (events.length) return { state: log.fold(events), seq: events[events.length - 1].seq };
  const state = await projection();
  // The payload shape of both origin types is `{ state, source: "legacy-json" }`; the fold keeps it type-safe per store.
  const draft = { at: new Date().toISOString(), actor: "runtime", type: log.origin, payload: { state, source: "legacy-json" } } as unknown as GlobalEventDraft;
  try {
    const event = await appendGlobalEvent(log.dir, draft, 0);
    return { state: log.fold([event as GlobalEvent]), seq: event.seq };
  } catch (error) {
    if (!(error instanceof EventConflictError)) throw error;
    const imported = await readGlobalEvents(log.dir);
    return { state: log.fold(imported), seq: imported.at(-1)?.seq ?? 0 };
  }
}

/**
 * Validate → append → apply → project for one store mutation, mirroring `TaskLedger.commit`: the dry run happens
 * inside the log lock so a reducer guard rejects the event before anything reaches the log, and a writer that finds
 * the log moved on re-folds and re-validates its remaining events there instead of losing them. `project` runs inside
 * the lock too, so readers never see a projection older than the log tip.
 */
export async function commitGlobal<S>(
  log: GlobalLog<S>,
  view: GlobalLogView<S>,
  plans: readonly GlobalEventPlan[],
  project: (state: S) => Promise<void>,
): Promise<void> {
  let state = view.state;
  let seq = view.seq;
  for (const plan of plans) {
    await planGlobalEvent(log.dir, seq, async () => {
      const draft = { at: new Date().toISOString(), actor: "runtime", type: plan.type, payload: plan.payload } as GlobalEventDraft;
      log.apply(structuredClone(state), draft as GlobalEvent);
      return draft;
    }, async () => {
      const events = await readGlobalEvents(log.dir);
      state = log.fold(events);
      seq = events.at(-1)?.seq ?? 0;
      return seq;
    }, async event => {
      log.apply(state, event as unknown as GlobalEvent);
      seq = event.seq;
      await project(state);
    });
  }
}
