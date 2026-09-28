import type { TaskPhase, TaskState } from "../task-ledger";
import { InvariantError } from "./errors";
import type { TaskEventType } from "./types";

/**
 * The transition table from docs/cognitive-state-machine-plan-2026-09-28.md §4.3: current state × event → new state.
 * `foldTask` checks every status and phase change against it, so an event that would produce an unlisted transition is
 * rejected instead of silently reshaping the task. Origin events (`task/created`, `task/imported`) define the initial
 * state and are exempt. P2 removes the remaining direct assignments so this table becomes the only way in.
 */

export type PhaseKey = TaskPhase | "none";

export const STATUS_TRANSITIONS: Record<string, TaskEventType[]> = {
  "active->complete": ["status/changed"],
  "active->stopped": ["status/changed", "project-version/confirmed"],
  "active->needs-input": ["status/changed"],
  "needs-input->active": ["status/changed", "phase/changed", "worker-run/prepared", "contract/revised"],
  "needs-input->stopped": ["project-version/confirmed"],
  "stopped->active": ["status/changed", "phase/changed", "worker-run/prepared", "contract/revised"],
  "stopped->stopped": ["project-version/confirmed"],
  "complete->active": ["status/changed", "contract/revised"],
};

export const PHASE_TRANSITIONS: Record<string, TaskEventType[]> = {
  "none->plan": ["phase/changed", "contract/revised"],
  "none->plan-review": ["plan/revised"],
  "none->execute": ["plan/approved"],
  "plan->plan": ["phase/changed", "contract/revised"],
  "plan->plan-review": ["plan/submitted", "plan/revised"],
  "plan->execute": ["plan/approved"],
  "plan-review->plan": ["phase/changed", "contract/revised"],
  "plan-review->plan-review": ["plan/revised"],
  "plan-review->execute": ["plan/approved"],
  "execute->plan": ["phase/changed", "contract/revised"],
  "execute->plan-review": ["plan/revised"],
};

export function phaseKey(phase: TaskPhase | undefined): PhaseKey {
  return phase ?? "none";
}

export function assertStatusTransition(from: TaskState["status"], to: TaskState["status"], type: TaskEventType): void {
  if (from === to) return;
  if (!STATUS_TRANSITIONS[`${from}->${to}`]?.includes(type)) {
    throw new InvariantError("transition/status-not-allowed", `Event ${type} cannot move a task from ${from} to ${to}`);
  }
}

export function assertPhaseTransition(from: TaskPhase | undefined, to: TaskPhase | undefined, type: TaskEventType): void {
  if (from === to) return;
  if (!PHASE_TRANSITIONS[`${phaseKey(from)}->${phaseKey(to)}`]?.includes(type)) {
    throw new InvariantError("transition/phase-not-allowed", `Event ${type} cannot move a task from phase ${phaseKey(from)} to ${phaseKey(to)}`);
  }
}
