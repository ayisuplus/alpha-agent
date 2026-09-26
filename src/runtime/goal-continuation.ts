import type { TaskLedger } from "./task-ledger";

/** A checked-off plan step alone is not evidence that the task advanced. */
export function progressSignature(ledger: TaskLedger): string {
  const passing = [...new Set(ledger.state.evidence.filter(item => item.passed && item.revision === ledger.state.revision && (item.contractVersion ?? 1) === (ledger.state.contractVersion ?? 1)).map(item => item.criterionId))].sort();
  const resolved = ledger.state.cognition?.gaps.filter(item => item.resolvedAt).map(item => `${item.kind}:${item.description}:${item.resolvedAt}`) ?? [];
  return JSON.stringify({ revision: ledger.state.revision, passing, resolved });
}

export function goalStopReason(ledger: TaskLedger, cancelled: boolean, userControl: boolean, runError: string | null): string | null {
  if (!ledger.state.goal?.enabled) return null;
  if (ledger.state.goal.stopReason) return ledger.state.goal.stopReason;
  if (ledger.state.status === "complete") return "accepted";
  if (ledger.state.status === "needs-input") return ledger.state.blockedService ? `needs-input:${ledger.state.blockedService}` : "needs-input";
  if (ledger.state.phase === "plan-review") return "plan-review";
  if (cancelled) return "cancelled";
  if (ledger.state.status === "stopped") return /budget/i.test(ledger.state.lastFailure ?? runError ?? "") ? "budget-exhausted" : "stopped";
  if (runError) return "hard-error";
  if (userControl) return "user-control";
  if (ledger.state.phase === "plan") return "planning-incomplete";
  return ledger.completionGaps().length ? null : "accepted";
}

export function nextGoalCycle(ledger: TaskLedger, before: string | null, cancelled: boolean, userControl: boolean): { continue: boolean; noProgressRuns: number; stopReason: string | null } {
  const prior = ledger.state.goal?.noProgressRuns ?? 0;
  if (!ledger.state.goal?.enabled || ledger.state.status !== "active" || ledger.state.phase !== "execute" || !ledger.completionGaps().length || cancelled || userControl) {
    return { continue: false, noProgressRuns: prior, stopReason: goalStopReason(ledger, cancelled, userControl, null) };
  }
  const noProgressRuns = before === progressSignature(ledger) ? prior + 1 : 0;
  return noProgressRuns >= 2 ? { continue: false, noProgressRuns, stopReason: "no-progress" } : { continue: true, noProgressRuns, stopReason: null };
}
