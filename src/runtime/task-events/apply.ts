import type { TaskState } from "../task-ledger";
import { InvariantError } from "./errors";
import type { TaskEvent, TaskEventType } from "./types";
import { approvalReducers } from "./apply/approval";
import { contextReducers } from "./apply/context";
import { contractReducers } from "./apply/contract";
import { evidenceReducers } from "./apply/evidence";
import { graphReducers } from "./apply/graph";
import { lifecycleReducers } from "./apply/lifecycle";
import { planReducers } from "./apply/plan";
import { mailboxReducers } from "./apply/mailbox";
import { operationReducers } from "./apply/operation";
import { workerReducers } from "./apply/worker";

/**
 * Dispatch table for the fold. Each family is typed per event; the merge loses that narrowing, so the lookup casts once
 * here instead of in every reducer. `state.updatedAt` follows the event timestamp, which is what `save()` used to stamp.
 */
type AnyReducer = (state: TaskState, event: TaskEvent) => void;

const reducers = {
  ...approvalReducers,
  ...contextReducers,
  ...contractReducers,
  ...evidenceReducers,
  ...graphReducers,
  ...lifecycleReducers,
  ...mailboxReducers,
  ...operationReducers,
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
