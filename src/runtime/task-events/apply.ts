import type { TaskState } from "../task-ledger";
import { InvariantError } from "./errors";
import type { TaskEvent, TaskEventType } from "./types";
import { contractReducers } from "./apply/contract";
import { evidenceReducers } from "./apply/evidence";
import { lifecycleReducers } from "./apply/lifecycle";
import { planReducers } from "./apply/plan";
import { workerReducers } from "./apply/worker";

/**
 * Dispatch table for the fold. Each family is typed per event; the merge loses that narrowing, so the lookup casts once
 * here instead of in every reducer. `state.updatedAt` follows the event timestamp, which is what `save()` used to stamp.
 */
type AnyReducer = (state: TaskState, event: TaskEvent) => void;

const reducers = {
  ...contractReducers,
  ...evidenceReducers,
  ...lifecycleReducers,
  ...planReducers,
  ...workerReducers,
} as unknown as Partial<Record<TaskEventType, AnyReducer>>;

export function applyEvent(state: TaskState, event: TaskEvent): void {
  const reducer = reducers[event.type];
  if (!reducer) throw new InvariantError("fold/unknown-event", `No reducer for event type ${event.type}`);
  reducer(state, event);
  // An import records history; it must not touch the task, so the legacy timestamp survives the fold unchanged.
  if (event.type !== "task/imported") state.updatedAt = event.at;
}

export const registeredEventTypes = Object.keys(reducers) as TaskEventType[];
