/**
 * The seven Tianshu signals: pure trigger/resolve determination over the
 * evidence state summary, plus edge-triggered delivery decisions
 * (new or escalated signals only; same signal ≥60s cooldown).
 */

import type { ClaimKind } from "./claims";
import type { VerificationFamily } from "./change-class";

export type SignalKey =
  | "repeat-failure"
  | "verification-debt"
  | "claim-mismatch"
  | "todo-verification-gap"
  | "compact-reanchor"
  | "model-fallback"
  | "context-usage";

/** Who a signal is shown to. "status" = status bar only, never delivered as a message. */
export type SignalAudience = "model-status" | "user-model" | "model" | "status";

export const SIGNAL_AUDIENCE: Readonly<Record<SignalKey, SignalAudience>> = {
  "repeat-failure": "model-status",
  "verification-debt": "model-status",
  "claim-mismatch": "user-model",
  "todo-verification-gap": "model-status",
  "compact-reanchor": "model",
  "model-fallback": "status",
  "context-usage": "status",
};

/** Same-kind signals are not re-delivered within this window. */
export const SIGNAL_COOLDOWN_MS = 60_000;

const SIGNAL_ORDER: readonly SignalKey[] = [
  "repeat-failure",
  "verification-debt",
  "claim-mismatch",
  "todo-verification-gap",
  "compact-reanchor",
  "model-fallback",
  "context-usage",
];

/** Structural view of the state summary the signals are computed from. */
export interface SignalBasis {
  failure: { signature: string; toolName: string; count: number } | null;
  lastMutation: { seq: number; target: string } | null;
  lastVerification: { seq: number; family: VerificationFamily; command: string } | null;
  claimIssues: readonly { kind: ClaimKind }[];
  todos: readonly { content: string; done: boolean }[] | null;
  pendingReanchor: boolean;
  modelFallback: { from: string; to: string } | null;
  contextPercent: number | null;
}

/** Active signal before activation stamping. `base` changes on escalation. */
export interface SignalEval {
  key: SignalKey;
  base: string;
}

/** Stamped active signal (persisted in state; drives edge/escalation delivery). */
export interface SignalRecord {
  key: SignalKey;
  /** Event sequence where this signal activation began. */
  sinceSeq: number;
  /** `${base}#${sinceSeq}` — changes on escalation or re-activation. */
  token: string;
}

export interface DeliveryMark {
  at: number;
  token: string;
}

/** Which signals are active right now, and with what escalation base. */
export function evaluateSignals(basis: SignalBasis): SignalEval[] {
  const unverifiedMutation =
    basis.lastMutation !== null &&
    (basis.lastVerification === null || basis.lastVerification.seq < basis.lastMutation.seq);
  const allTodosDone = basis.todos !== null && basis.todos.length > 0 && basis.todos.every(todo => todo.done);
  const evaluated: SignalEval[] = [];
  for (const key of SIGNAL_ORDER) {
    switch (key) {
      case "repeat-failure":
        if (basis.failure !== null && basis.failure.count >= 2) {
          evaluated.push({ key, base: `repeat-failure:${basis.failure.count}` });
        }
        break;
      case "verification-debt":
        if (unverifiedMutation) evaluated.push({ key, base: `verification-debt:${basis.lastMutation?.seq ?? 0}` });
        break;
      case "claim-mismatch":
        if (basis.claimIssues.length > 0) {
          evaluated.push({ key, base: `claim-mismatch:${basis.claimIssues.map(issue => issue.kind).sort().join("+")}` });
        }
        break;
      case "todo-verification-gap":
        if (allTodosDone && unverifiedMutation) evaluated.push({ key, base: "todo-verification-gap" });
        break;
      case "compact-reanchor":
        if (basis.pendingReanchor) evaluated.push({ key, base: "compact-reanchor" });
        break;
      case "model-fallback":
        if (basis.modelFallback !== null) evaluated.push({ key, base: `model-fallback:${basis.modelFallback.to}` });
        break;
      case "context-usage":
        if (basis.contextPercent !== null) evaluated.push({ key, base: `context-usage:${basis.contextPercent}` });
        break;
    }
  }
  return evaluated;
}

/**
 * Stamp activations: a key that just appeared gets a fresh `sinceSeq`, an
 * ongoing activation keeps its stamp (stable token → no repeat injection).
 */
export function rollSignals(
  previous: readonly SignalRecord[],
  evaluated: readonly SignalEval[],
  seq: number,
): SignalRecord[] {
  return evaluated.map(evaluatedSignal => {
    const prior = previous.find(record => record.key === evaluatedSignal.key);
    const sinceSeq = prior?.sinceSeq ?? seq;
    return { key: evaluatedSignal.key, sinceSeq, token: `${evaluatedSignal.base}#${sinceSeq}` };
  });
}

/**
 * Deliverable reminders: signals whose token was never delivered (new or
 * escalated) and whose key is past the ≥60s cooldown. Suppressed edges stay
 * pending (their token stays undelivered) and go out after the cooldown.
 * Status-bar-only signals and compact-reanchor (delivered once as its own
 * message) are excluded.
 */
export function deliverableSignals(
  records: readonly SignalRecord[],
  delivered: Readonly<Record<string, DeliveryMark>>,
  now: number,
): SignalRecord[] {
  return records.filter(record => {
    const audience = SIGNAL_AUDIENCE[record.key];
    if (audience === "status" || record.key === "compact-reanchor") return false;
    const mark = delivered[record.key];
    if (mark !== undefined && mark.token === record.token) return false;
    return mark === undefined || now - mark.at >= SIGNAL_COOLDOWN_MS;
  });
}
