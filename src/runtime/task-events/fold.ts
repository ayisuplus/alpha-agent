import type { TaskState } from "../task-ledger";
import { applyEvent } from "./apply";
import { InvariantError } from "./errors";
import { assertPhaseTransition, assertStatusTransition } from "./transitions";
import type { TaskEvent } from "./types";

export interface FoldBase {
  /** Sequence number the snapshot covers; folding continues with the event after it. */
  seq: number;
  state: TaskState;
}

export interface FoldOptions {
  /** Start from a snapshot instead of the origin event. */
  base?: FoldBase;
  /** Reject status and phase changes the transition table does not list. On by default. */
  checkTransitions?: boolean;
}

/**
 * `foldTask(events)` is the only way a task state comes into existence: strict on sequence continuity, on the origin
 * event and on transitions (docs/cognitive-state-machine-plan-2026-09-28.md §4.3). The §4.6 state invariants are not
 * enforced per event, because a task in flight legitimately sits between them; `checkTaskInvariants` runs on the folded
 * result in tests, in development mode and in `bun run invariants`.
 */
export function foldTask(events: readonly TaskEvent[], options: FoldOptions = {}): TaskState {
  const state: TaskState = options.base ? structuredClone(options.base.state) : {} as TaskState;
  let expectedSeq = options.base?.seq ?? 0;
  const checkTransitions = options.checkTransitions !== false;
  for (const event of events) {
    expectedSeq += 1;
    if (event.seq !== expectedSeq) throw new InvariantError("fold/seq-gap", `Expected seq ${expectedSeq}, found ${event.seq}`);
    const origin = event.type === "task/created" || event.type === "task/imported";
    if (expectedSeq === 1) {
      if (!origin || options.base) throw new InvariantError("fold/missing-origin", `Log starts with ${event.type} instead of task/created or task/imported`);
    } else if (origin) {
      throw new InvariantError("fold/duplicate-origin", `${event.type} appears at seq ${event.seq}`);
    }
    const status = state.status;
    const phase = state.phase;
    applyEvent(state, event);
    if (checkTransitions && !origin && status !== undefined) {
      assertStatusTransition(status, state.status, event.type);
      assertPhaseTransition(phase, state.phase, event.type);
    }
  }
  if (!options.base && expectedSeq === 0) throw new InvariantError("fold/empty-log", "A task event log needs an origin event");
  return state;
}
