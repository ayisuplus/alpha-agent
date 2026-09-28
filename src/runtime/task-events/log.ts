import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TaskState } from "../task-ledger";
import { EventConflictError } from "./errors";
import type { TaskEvent, TaskEventDraft } from "./types";

/**
 * Append-only task event log: `<dataRoot>/tasks/<id>/events.v1.jsonl`, one JSON object per line
 * (`{ seq, at, actor, runId?, type, payload }`). Appends are serialized by an owner-stamped lock directory shared
 * with every Alpha process and use sequence compare-and-swap, so the main process and subagent processes can write
 * the same task safely; a lock whose owner died is taken over immediately. Snapshots are pure caches: deleting them
 * changes nothing but load time.
 */
export const EVENT_LOG_VERSION = 1;
export const SNAPSHOT_INTERVAL = 200;
/** Backstop for an unreadable lock owner; a dead owner is detected by pid without waiting. */
const LOCK_STALE_MS = 10_000;
/** How long a lock without an owner record is trusted: the window between creating the lock and stamping it. */
const LOCK_GRACE_MS = 2_000;
const LOCK_RETRY_MS = 20;
const TAIL_WINDOW_BYTES = 64 * 1024;

export function taskLogDir(ledgerFile: string): string {
  return join(dirname(ledgerFile), basename(ledgerFile).replace(/\.json$/, ""));
}

export function eventLogPath(dir: string): string {
  return join(dir, `events.v${EVENT_LOG_VERSION}.jsonl`);
}

export function snapshotPath(dir: string, seq: number): string {
  return join(dir, `snapshot.${seq}.json`);
}

async function orDefault<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try { return await promise; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/** Splits log contents into durable events plus the byte length they occupy; a torn trailing line is left out. */
function durablePrefix(contents: string): { events: TaskEvent[]; validBytes: number } {
  const events: TaskEvent[] = [];
  let validBytes = 0;
  let offset = 0;
  for (const line of contents.split("\n")) {
    const length = Buffer.byteLength(line) + 1;
    if (!line.trim()) { offset += length; continue; }
    try { events.push(JSON.parse(line) as TaskEvent); } catch (error) {
      if (offset + length === contents.length + 1) break;   // last line, cut short by a crash
      throw error;
    }
    validBytes += length;
    offset += length;
  }
  return { events, validBytes };
}

export interface LogTail { seq: number; size: number; validBytes: number; torn: boolean }

/**
 * Last durable sequence number, read from the end of the log. A line cut short by a crash is reported as `torn` so the
 * next append truncates it; a last line wider than the tail window falls back to reading the whole file.
 */
export async function inspectLogTail(dir: string): Promise<LogTail> {
  const file = eventLogPath(dir);
  const size = await orDefault(stat(file).then(item => item.size), 0);
  if (!size) return { seq: 0, size, validBytes: 0, torn: false };
  const handle = await open(file, "r");
  try {
    const start = Math.max(0, size - TAIL_WINDOW_BYTES);
    const window = Buffer.alloc(size - start);
    await handle.read(window, 0, window.length, start);
    const text = window.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    const torn = lastNewline !== text.length - 1;
    const complete = text.slice(0, torn ? lastNewline : text.length - 1);
    const line = complete.slice(complete.lastIndexOf("\n") + 1).trim();
    const event = line ? JSON.parse(line) as TaskEvent : null;
    if (!event || !Number.isInteger(event.seq)) throw new Error("Trailing event is unreadable");
    return { seq: event.seq, size, validBytes: torn ? start + lastNewline + 1 : size, torn };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === "Trailing event is unreadable")) throw error;
    const contents = await orDefault(readFile(file, "utf8"), "");
    const prefix = durablePrefix(contents);
    return { seq: prefix.events.length ? prefix.events[prefix.events.length - 1].seq : 0, size, validBytes: prefix.validBytes, torn: prefix.validBytes < size };
  } finally {
    await handle.close();
  }
}

/** Every durable event in order, optionally starting at the byte offset a snapshot recorded. */
export async function readEvents(dir: string, fromOffset = 0): Promise<TaskEvent[]> {
  const file = eventLogPath(dir);
  const size = await orDefault(stat(file).then(item => item.size), 0);
  if (size <= fromOffset) return [];
  if (!fromOffset) return durablePrefix(await orDefault(readFile(file, "utf8"), "")).events;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size - fromOffset);
    await handle.read(buffer, 0, buffer.length, fromOffset);
    return durablePrefix(buffer.toString("utf8")).events;
  } finally {
    await handle.close();
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function withLogLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  // Always create the directory: a log folder can disappear (task cleanup, a test fixture) between two appends.
  await mkdir(dir, { recursive: true });
  const lock = join(dir, "events.lock");
  while (true) {
    try {
      // mkdir is the atomic, cross-process exclusion; a file created with "wx" proved not to be exclusive on Windows.
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = JSON.parse(await orDefault(readFile(join(lock, "owner.json"), "utf8"), "null")) as { pid?: number } | null;
      const age = Date.now() - await orDefault(stat(lock).then(item => item.mtimeMs), Date.now());
      // A freshly created lock may not have its owner record yet: wait out that window before considering a takeover.
      const held = owner?.pid === undefined ? age <= LOCK_GRACE_MS : (owner.pid === process.pid || processAlive(owner.pid)) && age <= LOCK_STALE_MS;
      if (held) {
        await Bun.sleep(LOCK_RETRY_MS);
        continue;
      }
      // A lock whose owner died (a killed run, a crashed app) is taken over at once instead of blocking the task.
      await rm(lock, { recursive: true, force: true });
    }
  }
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Appends one event under the log lock, rejecting it unless the log still ends at `expectedSeq`. `afterAppend` runs
 * before the lock is released, so a writer that projects the state cannot be interleaved with another append and leave
 * readers a projection older than the log.
 */
export async function appendEvent(dir: string, draft: TaskEventDraft, expectedSeq: number, afterAppend?: (event: TaskEvent) => Promise<void>): Promise<TaskEvent> {
  return withLogLock(dir, async () => {
    const tail = await inspectLogTail(dir);
    if (tail.torn && tail.validBytes < tail.size) await truncate(eventLogPath(dir), tail.validBytes);
    if (tail.seq !== expectedSeq) throw new EventConflictError(expectedSeq, tail.seq);
    const event = { seq: expectedSeq + 1, at: draft.at, actor: draft.actor, ...(draft.runId ? { runId: draft.runId } : {}), type: draft.type, payload: draft.payload } as TaskEvent;
    await appendFile(eventLogPath(dir), `${JSON.stringify(event)}\n`);
    if (afterAppend) await afterAppend(event);
    return event;
  });
}

/**
 * Appends the event a plan produces, planning *inside* the lock. When another writer got there first the plan is
 * re-made after `onStale` re-folds, so sustained contention resolves instead of exhausting a retry budget.
 */
export async function appendPlannedEvent(
  dir: string,
  expectedSeq: number,
  plan: () => Promise<TaskEventDraft | null>,
  onStale: () => Promise<number>,
  afterAppend?: (event: TaskEvent) => Promise<void>,
): Promise<TaskEvent | null> {
  return withLogLock(dir, async () => {
    let tail = await inspectLogTail(dir);
    if (tail.torn && tail.validBytes < tail.size) await truncate(eventLogPath(dir), tail.validBytes);
    if (tail.seq !== expectedSeq) {
      // Holding the lock, no other writer can slip in between re-folding and appending.
      expectedSeq = await onStale();
      tail = await inspectLogTail(dir);
      if (tail.seq !== expectedSeq) throw new EventConflictError(expectedSeq, tail.seq);
    }
    const draft = await plan();
    if (!draft) return null;
    const event = { seq: expectedSeq + 1, at: draft.at, actor: draft.actor, ...(draft.runId ? { runId: draft.runId } : {}), type: draft.type, payload: draft.payload } as TaskEvent;
    await appendFile(eventLogPath(dir), `${JSON.stringify(event)}\n`);
    if (afterAppend) await afterAppend(event);
    return event;
  });
}

export async function writeSnapshot(dir: string, seq: number, state: TaskState): Promise<void> {
  const file = snapshotPath(dir, seq);
  // The offset must end exactly at `seq`, so it is measured from the log rather than taken from the current size.
  const lines = (await orDefault(readFile(eventLogPath(dir), "utf8"), "")).split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length && index < seq; index++) offset += Buffer.byteLength(lines[index]) + 1;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: EVENT_LOG_VERSION, seq, offset, state }, null, 2));
  await rename(temporary, file);
  // Snapshots are caches; the newest one is enough, so every older copy goes.
  const older = (await readdir(dir).catch(() => [] as string[]))
    .map(name => /^snapshot\.(\d+)\.json$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined && Number(value) < seq);
  for (const name of older) await rm(snapshotPath(dir, Number(name)), { force: true });
}

export async function latestSnapshot(dir: string): Promise<{ seq: number; offset: number; state: TaskState } | null> {
  const seqs = (await readdir(dir).catch(() => [] as string[])).map(name => /^snapshot\.(\d+)\.json$/.exec(name)?.[1]).filter((value): value is string => value !== undefined).map(Number);
  if (!seqs.length) return null;
  const contents = await orDefault(readFile(snapshotPath(dir, Math.max(...seqs)), "utf8"), null);
  if (!contents) return null;
  const snapshot = JSON.parse(contents) as { seq: number; offset?: number; state: TaskState };
  return { seq: snapshot.seq, offset: snapshot.offset ?? 0, state: snapshot.state };
}
