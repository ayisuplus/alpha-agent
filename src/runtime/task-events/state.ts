import type { TaskState } from "../task-ledger";

/**
 * Replaces a state object's contents in place, keeping the replacement's key order so the JSON projection stays
 * byte-identical to what the pre-event-log ledger wrote. Used by the origin events and by the ledger's re-fold.
 */
export function replaceState(state: TaskState, next: TaskState): void {
  for (const key of Object.keys(state) as Array<keyof TaskState>) {
    if (!(key in next)) delete (state as Partial<TaskState>)[key];
  }
  Object.assign(state, next);
}
