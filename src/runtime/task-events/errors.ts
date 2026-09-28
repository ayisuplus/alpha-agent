/**
 * Raised when an event or a log breaks a rule from docs/cognitive-state-machine-plan-2026-09-28.md §4.6. The message
 * stays exactly what the equivalent ledger guard said before the event log, so callers and recorded baselines keep
 * matching on text; `code` is the stable machine-readable addition.
 */
export class InvariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/** Raised when another writer appended first; the caller must reload, re-fold and re-plan its event. */
export class EventConflictError extends Error {
  constructor(readonly expectedSeq: number, readonly actualSeq: number) {
    super(`Task event log moved on: expected seq ${expectedSeq}, found ${actualSeq}; reload before updating`);
    this.name = "EventConflictError";
  }
}
