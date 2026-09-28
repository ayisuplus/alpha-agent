import type { WorkerStopReason } from "./task-events";

/**
 * Why a subagent attempt ended, as a fact in the parent task's log instead of a sentence in `findings`.
 * `no-result` is the case the plan calls out: the attempt finished without submitting `alpha_worker_result`, which used
 * to be indistinguishable from any other failure except by matching message text.
 */

/** Thrown inside a worker run when the reason it ended matters to the parent task's log. */
export class WorkerStopError extends Error {
  constructor(readonly stopReason: WorkerStopReason, message: string) {
    super(message);
    this.name = "WorkerStopError";
  }
}

export interface WorkerEndSignals {
  /** The child classified its own end and wrote it into `result.json`. */
  resultStopReason?: WorkerStopReason;
  /** `WorkerResult.status` from the child. */
  resultStatus?: "completed" | "needs-context" | "blocked" | "failed";
  /** The user or the coordinator cancelled the attempt. */
  cancelled?: boolean;
  /** The parent-side hard timeout fired while the child was still running. */
  timedOut?: boolean;
  /** The child never reported usage, i.e. it never got to write a result. */
  usageIncomplete?: boolean;
  errorText?: string;
}

const NO_RESULT_TEXT = "did not submit alpha_worker_result";

/** Classifies an attempt's end from the signals the parent process actually has; the child's own reason wins. */
export function workerStopReason(signals: WorkerEndSignals): WorkerStopReason {
  if (signals.resultStopReason) return signals.resultStopReason;
  if (signals.resultStatus === "needs-context" || signals.resultStatus === "blocked") return "needs-input";
  if (signals.cancelled) return "aborted";
  if (signals.timedOut) return "no-result";
  if (signals.errorText?.includes(NO_RESULT_TEXT)) return "no-result";
  if (signals.resultStatus === "completed") return "completed";
  if (signals.errorText) return "error";
  return signals.usageIncomplete ? "no-result" : "completed";
}
