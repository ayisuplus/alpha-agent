import type { GoalStopReason, TaskLedger } from "./task-ledger";

/** A checked-off plan step alone is not evidence that the task advanced. */
export function progressSignature(ledger: TaskLedger): string {
  const passing = [...new Set(ledger.state.evidence.filter(item => item.passed && item.revision === ledger.state.revision && (item.contractVersion ?? 1) === (ledger.state.contractVersion ?? 1)).map(item => item.criterionId))].sort();
  const resolved = ledger.state.cognition?.gaps.filter(item => item.resolvedAt).map(item => `${item.kind}:${item.description}:${item.resolvedAt}`) ?? [];
  return JSON.stringify({ revision: ledger.state.revision, passing, resolved });
}

export function goalStopReason(ledger: TaskLedger, cancelled: boolean, userControl: boolean, runError: string | null): GoalStopReason | null {
  if (!ledger.state.goal?.enabled) return null;
  if (ledger.state.goal.stopReason) return ledger.state.goal.stopReason;
  if (ledger.state.status === "complete") return "accepted";
  if (ledger.state.status === "needs-input") return ledger.state.pauseReason ? `needs-input:${ledger.state.pauseReason}` : "needs-input";
  if (ledger.state.phase === "plan-review") return "plan-review";
  if (cancelled) return "cancelled";
  if (ledger.state.status === "stopped") {
    // The stop code wins; the text match is only a fallback for ledgers stopped before codes existed.
    if (ledger.state.stop) return ledger.state.stop.reason === "budget" ? "budget-exhausted" : "stopped";
    return /budget/i.test(ledger.state.lastFailure ?? runError ?? "") ? "budget-exhausted" : "stopped";
  }
  if (runError) return "hard-error";
  if (userControl) return "user-control";
  if (ledger.state.phase === "plan") return "planning-incomplete";
  return ledger.completionGaps().length ? null : "accepted";
}

export function nextGoalCycle(ledger: TaskLedger, before: string | null, cancelled: boolean, userControl: boolean): { continue: boolean; noProgressRuns: number; stopReason: GoalStopReason | null } {
  const prior = ledger.state.goal?.noProgressRuns ?? 0;
  if (!ledger.state.goal?.enabled || ledger.state.status !== "active" || ledger.state.phase !== "execute" || !ledger.completionGaps().length || cancelled || userControl) {
    return { continue: false, noProgressRuns: prior, stopReason: goalStopReason(ledger, cancelled, userControl, null) };
  }
  const noProgressRuns = before === progressSignature(ledger) ? prior + 1 : 0;
  return noProgressRuns >= 2 ? { continue: false, noProgressRuns, stopReason: "no-progress" } : { continue: true, noProgressRuns, stopReason: null };
}

/** The graph's own progress: node statuses plus the source revision, so a run that entered or exited a node counts. */
export function planGraphSignature(ledger: TaskLedger): string {
  return JSON.stringify({ revision: ledger.state.revision, nodes: (ledger.state.cognition?.nodes ?? []).map(node => `${node.id}:${node.status}`) });
}

/**
 * A node the coordinator still owes work on: one it entered without exiting, one ready to start (a ready node hosted
 * by a worker is the coordinator's to dispatch), or one reopened for redo — without the last case a graph whose only
 * pending work is a reopened node would sit still (§3.3/§3.5).
 */
export function planActionableNode(ledger: TaskLedger): string | null {
  const nodes = ledger.state.cognition?.nodes ?? [];
  return nodes.find(node => node.status === "active")?.id
    ?? nodes.find(node => node.status === "reopened")?.id
    ?? nodes.find(node => node.status === "ready")?.id
    ?? null;
}

/**
 * §3.3/§3.6: the approved plan graph is enforced, not advisory. A run that stops while the graph still has a node to
 * exit or enter continues on the next run; two consecutive runs that move neither the graph nor the evidence end the
 * loop, so a model that keeps stopping cannot spin forever. Goal mode drives its own continuation.
 */
export function nextPlanCycle(input: { ledger: TaskLedger; graphBefore: string | null; evidenceBefore: string | null; noProgressRuns: number; cancelled: boolean; userControl: boolean }): { continue: boolean; noProgressRuns: number; stalled: boolean } {
  const { ledger } = input;
  const quiet = { continue: false, noProgressRuns: input.noProgressRuns, stalled: false };
  if (ledger.state.goal?.enabled || input.cancelled || input.userControl) return quiet;
  if (ledger.state.status !== "active" || ledger.state.phase !== "execute") return quiet;
  if (!planActionableNode(ledger)) return quiet;
  const advanced = input.graphBefore !== planGraphSignature(ledger) || input.evidenceBefore !== progressSignature(ledger);
  const noProgressRuns = advanced ? 0 : input.noProgressRuns + 1;
  return noProgressRuns >= 2 ? { continue: false, noProgressRuns, stalled: true } : { continue: true, noProgressRuns, stalled: false };
}
