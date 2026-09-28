import type { ActivityEntry, GuidanceStatus, ReviewSummary, RunRecord, TaskTimelineEvent, TaskView } from "../api/types";
import { TERMINAL_PHASES, type Tone } from "./labels";

export interface ToolCall {
  id: string;
  name: string;
  target?: string;
  intent?: string;
  state: "running" | "done" | "error";
  at: string;
}

export type Block =
  | { type: "text"; id: string; at: string; text: string; live?: boolean }
  | { type: "tools"; id: string; at: string; calls: ToolCall[] }
  | { type: "phase"; id: string; at: string; phase: string }
  | { type: "check"; id: string; at: string; name: string; passed: boolean; detail?: string; /** When an `evidence/recorded` durable row covers this check, its timestamp joins the evidence record. */ evidenceAt?: string }
  | { type: "error"; id: string; at: string; message: string }
  | { type: "guidance"; id: string; at: string; text: string; status?: GuidanceStatus }
  | { type: "event"; id: string; at: string; seq: number; eventType: string; label: string; detail?: string; tone?: TaskTimelineEvent["tone"] };

/**
 * What started an operation: a new task, an objective revision, a repair run, a follow-up question, or a runtime-only
 * publish/verify.
 */
export type TurnKind = "create" | "revise" | "resume" | "ask" | "publish" | "verify" | "other";

export interface Turn {
  type: "turn";
  id: string;
  index: number;
  kind: TurnKind;
  startedAt: string;
  endedAt: string;
  contractVersion: number;
  blocks: Block[];
  outcome: string | null;
  /** Tone of a durable `outcome`; when set, the outcome label comes from the event track, not from `phaseInfo`. */
  outcomeTone?: Tone;
  toolCount: number;
  review?: ReviewSummary;
  live: boolean;
  modelRun: boolean;
  /** Models of the ledger's run records that finished inside this turn (a repair turn can hold several runs). */
  models: string[];
  usageTokens: number;
}

export type TimelineItem =
  | { type: "objective"; id: string; version: number; text: string; at: string | null; current: boolean }
  | { type: "guidance"; id: string; text: string; status?: GuidanceStatus; at: string }
  /** A follow-up question; its answer is the turn that follows. */
  | { type: "question"; id: string; text: string; at: string }
  | { type: "review"; id: string; review: ReviewSummary; at: string }
  /** A durable event row that no turn claimed (a workbench action between runs, an import). */
  | { type: "event"; id: string; at: string; seq: number; label: string; detail?: string; tone?: TaskTimelineEvent["tone"] }
  | { type: "legacy"; id: string; at: string | null }
  | Turn;

export interface TimelineInput {
  task: Pick<TaskView, "objective" | "contractVersion" | "contractHistory" | "guidanceHistory" | "createdAt"> & { runs?: RunRecord[] };
  activity: ActivityEntry[];
  reviews: ReviewSummary[];
  /** The durable event track of the task; empty for ledgers recorded before it existed. */
  events?: TaskTimelineEvent[];
  /** Whether an operation for this task is in progress right now. */
  busy: boolean;
}

/** Adds entries that are not yet known (by id) and keeps the list in recorded order. */
export function mergeActivity(current: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const known = new Set(current.map(entry => entry.id));
  const fresh: ActivityEntry[] = [];
  for (const entry of incoming) {
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    fresh.push(entry);
  }
  if (!fresh.length) return current;
  return [...current, ...fresh]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.recordedAt.localeCompare(b.entry.recordedAt) || a.index - b.index)
    .map(item => item.entry);
}

/** Appends the durable rows past the stored cursor; the log is append-only, so `seq` dedupes overlapping refreshes. */
export function mergeTaskEvents(current: TaskTimelineEvent[], incoming: TaskTimelineEvent[]): TaskTimelineEvent[] {
  const last = current.at(-1)?.seq ?? 0;
  const fresh = incoming.filter(row => row.seq > last);
  return fresh.length ? [...current, ...fresh] : current;
}

/** The acceptance criterion a check row verifies; the browser check records the "user-path" criterion. */
export function checkCriterion(name: string): string | null {
  return name === "browser" ? "user-path" : name === "build" ? "build" : null;
}

// Objective and guidance rows render from the task state itself (contractHistory, guidanceHistory); durable rows would repeat them.
const RENDERED_ELSEWHERE: Record<string, true> = { "task/created": true, "contract/revised": true, "guidance/recorded": true };

// Activity phases the durable track states precisely; when a turn has event rows, they render once, from the events.
const DURABLE_PHASES: Record<string, true> = { 待验收: true, 已验收: true, 已停止: true, 失败: true, 需要回答: true, 计划待审阅: true, "无实际进展，已停止": true, 继续规划: true };

// Which durable rows settle a turn's outcome, and how strongly; the last row of the strongest kind wins.
const OUTCOME_RANK: Record<string, number> = { "phase/changed": 1, "plan/submitted": 2, "plan/approved": 2, "status/changed": 3 };

const OUTCOME_TONES: Record<string, Tone> = { info: "accent", success: "success", warning: "warning", danger: "danger" };

/** A turn rebuilt from the durable track alone, for runs whose activity the server no longer has (e.g. after a restart). */
function durableTurn(runId: string, rows: TaskTimelineEvent[], contractVersion: number): Turn {
  return {
    type: "turn", id: runId, index: 0,
    kind: rows.some(row => row.type === "task/created") ? "create" : rows.some(row => row.type === "contract/revised") ? "revise" : "other",
    startedAt: rows[0].at, endedAt: rows.at(-1)!.at, contractVersion,
    blocks: [], outcome: null, toolCount: 0, modelRun: rows.some(row => row.type === "run/ended"),
    live: false, models: [], usageTokens: 0,
  };
}

/** Merges one run's durable rows into its turn: blocks ordered by time (ties by `seq`), outcome, phase and evidence joins. */
function attachDurable(turn: Turn, rows: TaskTimelineEvent[]): void {
  const blocks: Block[] = rows.flatMap(row => row.type in RENDERED_ELSEWHERE
    ? []
    : [{ type: "event" as const, id: `event-${row.seq}`, at: row.at, seq: row.seq, eventType: row.type, label: row.label, detail: row.detail, tone: row.tone }]);
  // Durable rows state task status precisely; the echoed activity phase strings would render them twice.
  if (blocks.length || turn.blocks.some(block => block.type === "event")) {
    turn.blocks = turn.blocks.filter(block => !(block.type === "phase" && block.phase in DURABLE_PHASES));
  }
  turn.blocks = [...turn.blocks, ...blocks]
    .sort((a, b) => a.at.localeCompare(b.at) || (a.type === "event" ? a.seq : 0) - (b.type === "event" ? b.seq : 0));
  let outcome: TaskTimelineEvent | null = null;
  for (const row of rows) {
    const rank = OUTCOME_RANK[row.type] ?? 0;
    if (rank && (!outcome || rank >= (OUTCOME_RANK[outcome.type] ?? 0))) outcome = row;
  }
  if (outcome) {
    turn.outcome = outcome.label;
    turn.outcomeTone = outcome.tone ? OUTCOME_TONES[outcome.tone] : "neutral";
  }
  const last = rows.at(-1)!;
  if (last.at > turn.endedAt) turn.endedAt = last.at;
  // Checks join their evidence through the durable row that recorded it, not through nearby timestamps.
  const evidenceRows = rows.filter(row => row.type === "evidence/recorded");
  if (!evidenceRows.length) return;
  for (const block of turn.blocks) {
    if (block.type !== "check") continue;
    const criterionId = checkCriterion(block.name);
    if (!criterionId) continue;
    const checkTime = Date.parse(block.at);
    let nearest: TaskTimelineEvent | null = null;
    let distance = Infinity;
    for (const row of evidenceRows) {
      if (row.refs?.criterionId !== criterionId) continue;
      const delta = Math.abs(Date.parse(row.at) - checkTime);
      if (delta < distance) { distance = delta; nearest = row; }
    }
    if (nearest) block.evidenceAt = nearest.at;
  }
}

/**
 * Merges the durable event track into the activity-built turns: rows join the turn of their run (creating one when the
 * activity log no longer has it), rows without a run join the turn surrounding them by time, and the rest become
 * task-level items, which are returned.
 */
function mergeDurable(turns: Turn[], events: TaskTimelineEvent[], contractVersion: number): TimelineItem[] {
  if (!events.length) return [];
  const rows = [...events].sort((a, b) => a.seq - b.seq);
  const byRun = new Map<string, TaskTimelineEvent[]>();
  const loose: TaskTimelineEvent[] = [];
  for (const row of rows) {
    if (!row.runId) { loose.push(row); continue; }
    const group = byRun.get(row.runId);
    if (group) group.push(row);
    else byRun.set(row.runId, [row]);
  }
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  for (const [runId, group] of byRun) {
    let turn = byId.get(runId);
    if (!turn) {
      turn = durableTurn(runId, group, contractVersion);
      turns.push(turn);
      byId.set(runId, turn);
    }
    attachDurable(turn, group);
  }
  const items: TimelineItem[] = [];
  for (const row of loose) {
    const turn = turns.find(item => row.at >= item.startedAt && row.at <= item.endedAt);
    if (turn) { attachDurable(turn, [row]); continue; }
    if (row.type in RENDERED_ELSEWHERE) continue;
    items.push({ type: "event", id: `event-${row.seq}`, at: row.at, seq: row.seq, label: row.label, detail: row.detail, tone: row.tone });
  }
  return items;
}

export function parseToolValue(value: string): { name: string; state: string } {
  const separator = value.indexOf(" · ");
  return separator < 0 ? { name: value, state: "" } : { name: value.slice(0, separator), state: value.slice(separator + 3) };
}

function buildTurn(id: string, entries: ActivityEntry[]): Turn {
  const blocks: Block[] = [];
  const calls: ToolCall[] = [];
  let kind: TurnKind = "other";
  let outcome: string | null = null;
  let toolCount = 0;
  let modelRun = false;
  const last = () => blocks.at(-1);

  for (const entry of entries) {
    if (entry.kind === "question") {
      kind = "ask";
    } else if (entry.kind === "text") {
      modelRun = true;
      const previous = last();
      if (previous?.type === "text") previous.text += entry.value;
      else blocks.push({ type: "text", id: entry.id, at: entry.recordedAt, text: entry.value });
    } else if (entry.kind === "tool") {
      const { name, state } = parseToolValue(entry.value);
      if (state === "开始" || state === "结束") {
        modelRun = true;
        const open = state === "结束"
          ? calls.find(call => call.state === "running" && (entry.callId ? call.id === entry.callId : call.name === name))
          : undefined;
        if (open) {
          open.state = entry.error ? "error" : "done";
          continue;
        }
        if (state === "开始") toolCount++;
        const call: ToolCall = { id: entry.callId ?? entry.id, name, target: entry.target, intent: entry.intent, state: state === "开始" ? "running" : entry.error ? "error" : "done", at: entry.recordedAt };
        calls.push(call);
        const previous = last();
        if (previous?.type === "tools") previous.calls.push(call);
        else blocks.push({ type: "tools", id: entry.id, at: entry.recordedAt, calls: [call] });
      } else {
        const failed = !!entry.error || state.includes("失败");
        const detail = state.startsWith("验收失败：") ? state.slice("验收失败：".length) : state === "通过" || state === "失败" ? undefined : state;
        blocks.push({ type: "check", id: entry.id, at: entry.recordedAt, name, passed: !failed, detail });
      }
    } else if (entry.kind === "status") {
      const phase = entry.value;
      if (phase === "任务已创建") { kind = "create"; continue; }
      if (phase.startsWith("目标修订至")) { kind = "revise"; continue; }
      if (phase === "回答追问") { kind = "ask"; continue; }
      if (TERMINAL_PHASES.has(phase)) outcome = phase;
      const previous = last();
      if (previous?.type === "phase" && previous.phase === phase) continue;
      blocks.push({ type: "phase", id: entry.id, at: entry.recordedAt, phase });
    } else if (entry.kind === "error") {
      blocks.push({ type: "error", id: entry.id, at: entry.recordedAt, message: entry.value });
    }
  }

  // A settled phase that more work followed (e.g. "待验收" right before verification starts) is not a result.
  const lastPhase = blocks.findLast(block => block.type === "phase");
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.type === "phase" && block !== lastPhase && TERMINAL_PHASES.has(block.phase)) blocks.splice(index, 1);
  }

  if (kind === "other") {
    const phases = blocks.flatMap(block => block.type === "phase" ? [block.phase] : []);
    if (modelRun || phases.includes("构建中")) kind = "resume";
    else if (phases.some(phase => phase.startsWith("本机预览："))) kind = "publish";
    else if (phases.includes("浏览器验收")) kind = "verify";
  }
  return {
    type: "turn", id, index: 0, kind, blocks, outcome, toolCount, modelRun, live: false, models: [], usageTokens: 0,
    startedAt: entries[0].recordedAt, endedAt: entries.at(-1)!.recordedAt, contractVersion: entries[0].contractVersion,
  };
}

const RANK: Record<TimelineItem["type"], number> = { objective: 0, legacy: 1, event: 2, guidance: 2, question: 2, review: 3, turn: 4 };

export function buildTimeline(input: TimelineInput): TimelineItem[] {
  const { task, activity, reviews, busy, events } = input;
  const items: TimelineItem[] = [];

  const history = task.contractHistory ?? [];
  for (let version = 1; version <= task.contractVersion; version++) {
    const text = version === task.contractVersion ? task.objective : history.find(item => item.version === version)?.objective;
    if (!text) continue;
    const at = version === 1 ? task.createdAt ?? null : history.find(item => item.version === version - 1)?.revisedAt ?? null;
    items.push({ type: "objective", id: `objective-${version}`, version, text, at, current: version === task.contractVersion });
  }

  const groups = new Map<string, ActivityEntry[]>();
  for (const entry of activity) {
    if (entry.kind === "guidance") continue;
    if (entry.kind === "question") items.push({ type: "question", id: `question-${entry.id}`, text: entry.value, at: entry.recordedAt });
    const key = entry.operationId ?? `entry-${entry.id}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const turns = [...groups.entries()].map(([id, entries]) => buildTurn(id, entries));
  items.push(...mergeDurable(turns, events ?? [], task.contractVersion));
  turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const latest = turns.at(-1);
  if (busy && latest && latest.outcome === null) latest.live = true;
  for (const turn of turns) {
    if (turn.live) continue;
    for (const block of turn.blocks) if (block.type === "tools") for (const call of block.calls) if (call.state === "running") call.state = "done";
  }

  for (const guidance of task.guidanceHistory ?? []) {
    const id = guidance.id ?? `guidance-${guidance.recordedAt}`;
    const turn = turns.find(item => guidance.recordedAt >= item.startedAt && (item.live || guidance.recordedAt <= item.endedAt));
    if (!turn) {
      items.push({ type: "guidance", id, text: guidance.instruction, status: guidance.status, at: guidance.recordedAt });
      continue;
    }
    const block: Block = { type: "guidance", id, at: guidance.recordedAt, text: guidance.instruction, status: guidance.status };
    const index = turn.blocks.findIndex(item => item.at > guidance.recordedAt);
    if (index < 0) turn.blocks.push(block);
    else turn.blocks.splice(index, 0, block);
  }

  // A run record is written when a model run ends, so it falls inside the turn that ran it.
  for (const run of task.runs ?? []) {
    const time = Date.parse(run.recordedAt);
    const turn = turns.find(item => time >= Date.parse(item.startedAt) - 1_000 && (item.live || time <= Date.parse(item.endedAt) + 5_000));
    if (turn) {
      if (!turn.models.includes(run.model)) turn.models.push(run.model);
      turn.usageTokens += run.usage?.totalTokens ?? 0;
    }
  }

  const byOperation = new Map(reviews.map(review => [review.operationId, review]));
  for (const turn of turns) {
    const review = byOperation.get(turn.id);
    if (review) {
      turn.review = review;
      byOperation.delete(turn.id);
    }
  }
  for (const review of byOperation.values()) items.push({ type: "review", id: `review-${review.operationId}`, review, at: review.recordedAt });
  if (!activity.length && !events?.length && !busy) items.push({ type: "legacy", id: "legacy", at: task.createdAt ?? null });

  items.push(...turns);
  const at = (item: TimelineItem) => item.type === "turn" ? item.startedAt : item.at ?? "";
  items.sort((a, b) => at(a).localeCompare(at(b)) || RANK[a.type] - RANK[b.type]);
  let index = 0;
  for (const item of items) if (item.type === "turn") item.index = ++index;
  return items;
}

/**
 * Appends streamed model text that the server has not yet flushed into an activity entry. Only the live turn is
 * copied, so every other item keeps its identity and memoized rendering stays cheap while text streams in.
 */
export function attachLiveText(items: TimelineItem[], liveText: string, busy: boolean, now: string): TimelineItem[] {
  if (!liveText) return items;
  let index = -1;
  for (let position = items.length - 1; position >= 0; position--) {
    const item = items[position];
    if (item.type === "turn" && item.live) { index = position; break; }
  }
  if (index < 0) {
    if (!busy) return items;
    const turns = items.filter(item => item.type === "turn").length;
    const text: Block = { type: "text", id: "live-text", at: now, text: liveText, live: true };
    return [...items, { type: "turn", id: "live", index: turns + 1, kind: "other", startedAt: now, endedAt: now, contractVersion: 0, blocks: [text], outcome: null, toolCount: 0, modelRun: true, live: true, models: [], usageTokens: 0 }];
  }
  const turn = items[index] as Turn;
  const blocks = [...turn.blocks];
  const previous = blocks.at(-1);
  if (previous?.type === "text") blocks[blocks.length - 1] = { ...previous, text: previous.text + liveText, live: true };
  else blocks.push({ type: "text", id: "live-text", at: now, text: liveText, live: true });
  const next = [...items];
  next[index] = { ...turn, blocks, modelRun: true };
  return next;
}

/** The phase of the operation in progress, as recorded in the live turn. */
export function livePhase(items: TimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.type !== "turn" || !item.live) continue;
    for (let block = item.blocks.length - 1; block >= 0; block--) {
      const candidate = item.blocks[block];
      if (candidate.type === "phase") return candidate.phase;
    }
  }
  return null;
}
