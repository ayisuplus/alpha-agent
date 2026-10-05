/**
 * Evidence state and pure reduction for the Tianshu layer. No I/O, no clock,
 * no model calls: every event carries its own timestamp and sequence ordering
 * comes from the reducer's counter.
 *
 * `TianshuSnapshot` is what goes into `pi.appendEntry("alpha-tianshu", …)`.
 * It is the full serializable state (summary fields + a bounded evidence
 * tail), so restoring the latest snapshot of a branch reproduces the exact
 * state of that point — branch rollback included.
 */

import { createHash } from "node:crypto";
import {
  IS_MODIFICATION_TOOL,
  classifyVerificationFamilies,
  isCodeMutationPath,
  isGitMutationCommand,
  type VerificationFamily,
} from "./change-class";
import { auditClaims, detectClaims, type ClaimIssue, type ClaimKind } from "./claims";
import {
  deliverableSignals,
  evaluateSignals,
  rollSignals,
  type DeliveryMark,
  type SignalRecord,
} from "./signals";

export type Quality = "measured" | "partial" | "missing";

export const RECENT_LIMIT = 12;
export const TODO_LIMIT = 16;

export interface EvidenceNote {
  seq: number;
  kind: "mutation" | "verification" | "failure" | "claim" | "compact" | "fallback" | "goal" | "todos";
  summary: string;
}

export interface FailureStreak {
  /** Error digest; tool output may contain secrets, so only digests are kept. */
  signature: string;
  toolName: string;
  count: number;
}

export interface VerificationNote {
  seq: number;
  family: VerificationFamily;
  command: string;
}

export interface TodoNote {
  content: string;
  done: boolean;
}

export interface TianshuSnapshot {
  v: 1;
  /** Monotonic event counter; mutation/verification freshness compares these. */
  seq: number;
  turn: number;
  activeSignals: SignalRecord[];
  delivered: Record<string, DeliveryMark>;
  pendingReanchor: boolean;
  failure: FailureStreak | null;
  lastMutation: { seq: number; target: string } | null;
  lastVerification: VerificationNote | null;
  lastPassedSeqByFamily: { test: number; type: number; lint: number };
  claimedKinds: ClaimKind[];
  claimIssues: ClaimIssue[];
  todos: TodoNote[] | null;
  goal: string | null;
  modelFallback: { from: string; to: string } | null;
  contextPercent: number | null;
  recent: EvidenceNote[];
}

export type TianshuState = TianshuSnapshot;

export type TianshuEvent =
  | { type: "tool-result"; at: number; toolName: string; toolCallId: string; isError: boolean; command?: string; path?: string; errorDigest?: string }
  | { type: "assistant-message"; at: number; text: string }
  | { type: "todos"; at: number; items: readonly TodoNote[] }
  | { type: "goal"; at: number; objective: string | null }
  | { type: "compact"; at: number }
  | { type: "model-fallback"; at: number; from: string; to: string }
  | { type: "model-fallback-resolved"; at: number }
  | { type: "context-usage"; at: number; percent: number | null }
  | { type: "turn-end"; at: number };

export type OutboundDelivery =
  | { kind: "reminder"; signal: SignalRecord }
  | { kind: "reanchor" };

export interface ReduceResult {
  state: TianshuState;
  /** Populated at turn-end (the delivery point); empty otherwise. */
  outbound: OutboundDelivery[];
}

export function emptyState(): TianshuState {
  return {
    v: 1,
    seq: 0,
    turn: 0,
    activeSignals: [],
    delivered: {},
    pendingReanchor: false,
    failure: null,
    lastMutation: null,
    lastVerification: null,
    lastPassedSeqByFamily: { test: 0, type: 0, lint: 0 },
    claimedKinds: [],
    claimIssues: [],
    todos: null,
    goal: null,
    modelFallback: null,
    contextPercent: null,
    recent: [],
  };
}

/** Digest only: tool output and command text may contain secrets. */
export function evidenceDigest(text: string): string {
  return createHash("sha256").update(text.slice(0, 500)).digest("hex").slice(0, 16);
}

export function toSnapshot(state: TianshuState): TianshuSnapshot {
  return { ...state, recent: state.recent.slice(-RECENT_LIMIT) };
}

export function restoreState(snapshot: TianshuState): TianshuState {
  return {
    ...snapshot,
    activeSignals: snapshot.activeSignals.map(record => ({ ...record })),
    delivered: { ...snapshot.delivered },
    claimedKinds: [...snapshot.claimedKinds],
    claimIssues: snapshot.claimIssues.map(issue => ({ ...issue })),
    lastPassedSeqByFamily: { ...snapshot.lastPassedSeqByFamily },
    todos: snapshot.todos === null ? null : snapshot.todos.slice(0, TODO_LIMIT),
    recent: snapshot.recent.slice(-RECENT_LIMIT),
  };
}

/** Entries as returned by `ctx.sessionManager.getEntries()` (chronological). */
export interface SessionEntryLike {
  id?: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: unknown;
}

function isSnapshotData(data: unknown): data is TianshuSnapshot {
  return typeof data === "object" && data !== null && (data as { v?: unknown }).v === 1;
}

/**
 * Rebuild state from the current branch's entries: the latest
 * `alpha-tianshu` snapshot on the leaf→root path. Entries outside the branch
 * (abandoned branches kept by the session tree) are skipped, so branching
 * backwards really rolls the state back. Without a leaf id the last snapshot
 * in chronological order wins.
 */
export function rebuildFromEntries(entries: readonly SessionEntryLike[], leafId?: string | null): TianshuState {
  let branch: Record<string, true> | null = null;
  if (leafId !== undefined && leafId !== null) {
    const byId = new Map<string, SessionEntryLike>();
    for (const entry of entries) if (entry.id !== undefined) byId.set(entry.id, entry);
    branch = {};
    let cursor = byId.get(leafId);
    while (cursor !== undefined && cursor.id !== undefined && branch[cursor.id] !== true) {
      branch[cursor.id] = true;
      cursor = cursor.parentId === undefined || cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
  }
  let latest: TianshuSnapshot | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "alpha-tianshu" || !isSnapshotData(entry.data)) continue;
    if (branch !== null && (entry.id === undefined || branch[entry.id] !== true)) continue;
    latest = entry.data;
  }
  return latest === null ? emptyState() : restoreState(latest);
}

/** Summary fields whose change warrants an `appendEntry` outside turn boundaries. */
export function summaryChanged(before: TianshuState, after: TianshuState): boolean {
  const strip = (state: TianshuState) =>
    JSON.stringify({ ...state, recent: undefined, seq: undefined, delivered: undefined });
  return strip(before) !== strip(after);
}

export interface EvidenceFrame {
  facts: {
    turn: number;
    events: number;
    failure: FailureStreak | null;
    lastMutation: { seq: number; target: string } | null;
    lastVerification: VerificationNote | null;
    unverifiedMutation: boolean;
    claimedKinds: ClaimKind[];
    claimIssueKinds: ClaimKind[];
    todos: { total: number; open: number } | null;
    goal: string | null;
    pendingReanchor: boolean;
    modelFallback: { from: string; to: string } | null;
    contextPercent: number | null;
  };
  signals: SignalRecord[];
  /** Evidence sources in time order. */
  sources: string[];
  quality: { toolResults: Quality; verification: Quality; context: Quality };
}

/** Evidence frame: facts, signals, evidence sources, measurement quality. */
export function buildFrame(state: TianshuState): EvidenceFrame {
  const unverifiedMutation =
    state.lastMutation !== null &&
    (state.lastVerification === null || state.lastVerification.seq < state.lastMutation.seq);
  return {
    facts: {
      turn: state.turn,
      events: state.seq,
      failure: state.failure,
      lastMutation: state.lastMutation,
      lastVerification: state.lastVerification,
      unverifiedMutation,
      claimedKinds: [...state.claimedKinds],
      claimIssueKinds: state.claimIssues.map(issue => issue.kind),
      todos: state.todos === null ? null : { total: state.todos.length, open: state.todos.filter(todo => !todo.done).length },
      goal: state.goal,
      pendingReanchor: state.pendingReanchor,
      modelFallback: state.modelFallback,
      contextPercent: state.contextPercent,
    },
    signals: rollSignals(state.activeSignals, evaluateSignals(state), state.seq),
    sources: state.recent.map(note => `${note.seq} ${note.kind} ${note.summary}`),
    quality: {
      toolResults: state.recent.length > 0 ? "measured" : "missing",
      verification: state.lastVerification !== null ? "measured" : state.lastMutation !== null ? "partial" : "missing",
      context: state.contextPercent !== null ? "measured" : "missing",
    },
  };
}

function refreshClaimIssues(state: TianshuState): TianshuState {
  return {
    ...state,
    claimIssues: auditClaims(state.claimedKinds, {
      lastMutationSeq: state.lastMutation?.seq ?? 0,
      lastPassedSeqByFamily: state.lastPassedSeqByFamily,
    }),
  };
}

function trimRecent(notes: EvidenceNote[]): EvidenceNote[] {
  return notes.slice(-RECENT_LIMIT);
}

/** Pure reduction. Advisory only: nothing here can block a tool or start a turn. */
export function applyEvent(state: TianshuState, event: TianshuEvent): ReduceResult {
  const seq = state.seq + 1;
  const notes: EvidenceNote[] = [];
  switch (event.type) {
    case "tool-result": {
      const next: TianshuState = { ...state, seq };
      if (event.isError) {
        const signature = event.errorDigest ?? evidenceDigest(`${event.toolName} ${event.command ?? event.path ?? ""}`);
        next.failure =
          state.failure !== null && state.failure.signature === signature
            ? { signature, toolName: event.toolName, count: state.failure.count + 1 }
            : { signature, toolName: event.toolName, count: 1 };
        notes.push({ seq, kind: "failure", summary: `${event.toolName} 失败 签名 ${signature}` });
      } else {
        next.failure = null;
        const isMutation =
          (IS_MODIFICATION_TOOL[event.toolName] === true && isCodeMutationPath(event.path)) ||
          (event.toolName === "bash" && isGitMutationCommand(event.command));
        if (isMutation) {
          const target = event.path ?? event.command ?? event.toolName;
          next.lastMutation = { seq, target };
          notes.push({ seq, kind: "mutation", summary: `${event.toolName} ${target}` });
        }
        const families = event.toolName === "bash" ? classifyVerificationFamilies(event.command) : [];
        if (families.length > 0) {
          next.lastVerification = { seq, family: families[0] as VerificationFamily, command: event.command ?? "" };
          const byFamily = { ...state.lastPassedSeqByFamily };
          for (const family of families) byFamily[family] = seq;
          next.lastPassedSeqByFamily = byFamily;
          notes.push({ seq, kind: "verification", summary: `${event.command} ✓ (${families.join("+")} 族)` });
        }
      }
      next.recent = trimRecent([...state.recent, ...notes]);
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "assistant-message": {
      const claimed = detectClaims(event.text);
      const next: TianshuState = { ...state, seq };
      if (claimed.length > 0) {
        const merged = new Set<ClaimKind>([...state.claimedKinds, ...claimed]);
        next.claimedKinds = [...merged].sort();
        notes.push({ seq, kind: "claim", summary: `宣称 ${claimed.join("+")}` });
      }
      next.recent = trimRecent([...state.recent, ...notes]);
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "todos": {
      const next: TianshuState = { ...state, seq, todos: event.items.slice(0, TODO_LIMIT).map(item => ({ ...item })) };
      notes.push({ seq, kind: "todos", summary: `待办 ${event.items.length} 项` });
      next.recent = trimRecent([...state.recent, ...notes]);
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "goal": {
      const next: TianshuState = { ...state, seq, goal: event.objective };
      notes.push({ seq, kind: "goal", summary: event.objective ?? "清除目标" });
      next.recent = trimRecent([...state.recent, ...notes]);
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "compact": {
      const next: TianshuState = { ...state, seq, pendingReanchor: true };
      notes.push({ seq, kind: "compact", summary: "上下文压缩，待重锚" });
      next.recent = trimRecent([...state.recent, ...notes]);
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "model-fallback": {
      const next: TianshuState = { ...state, seq, modelFallback: { from: event.from, to: event.to } };
      notes.push({ seq, kind: "fallback", summary: `${event.from} → ${event.to}` });
      next.recent = trimRecent([...state.recent, ...notes]);
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "model-fallback-resolved": {
      const next: TianshuState = { ...state, seq, modelFallback: null };
      notes.push({ seq, kind: "fallback", summary: "模型降级解除" });
      next.recent = trimRecent([...state.recent, ...notes]);
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "context-usage": {
      const next: TianshuState = { ...state, seq, contextPercent: event.percent };
      return { state: refreshClaimIssues(next), outbound: [] };
    }
    case "turn-end": {
      const anchorPending = state.pendingReanchor;
      const basis = anchorPending ? { ...state, pendingReanchor: false } : state;
      const base: TianshuState = { ...basis, seq, turn: state.turn + 1 };
      const records = rollSignals(state.activeSignals, evaluateSignals(base), seq);
      const delivered: Record<string, DeliveryMark> = { ...base.delivered };
      const outbound: OutboundDelivery[] = [];
      for (const record of deliverableSignals(records, base.delivered, event.at)) {
        delivered[record.key] = { at: event.at, token: record.token };
        outbound.push({ kind: "reminder", signal: record });
      }
      if (anchorPending) {
        const anchor = records.find(record => record.key === "compact-reanchor");
        delivered["compact-reanchor"] = { at: event.at, token: anchor?.token ?? `compact-reanchor#${seq}` };
        outbound.push({ kind: "reanchor" });
      }
      return {
        state: refreshClaimIssues({ ...base, activeSignals: records, delivered }),
        outbound,
      };
    }
  }
}
