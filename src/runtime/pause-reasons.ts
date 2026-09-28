/**
 * Pause reason codes from docs/cognitive-state-machine-plan-2026-09-28.md §4.4.
 *
 * A paused task records *why* it stopped as a code, and the workbench derives its buttons from that code instead of
 * parsing a message. Before this, `TaskState.blockedService` held one of sixteen free-text service names and the UI
 * could only special-case a single value; `LEGACY_SERVICE_TO_REASON` is the migration table for imported ledgers.
 */

export const PAUSE_REASONS = [
  "approval",
  "question",
  "worker-no-result",
  "sandbox",
  "model",
  "project-state",
  "capability",
  "budget",
] as const;

export type PauseReasonCode = (typeof PAUSE_REASONS)[number];

/**
 * Why a task stopped. `needs-input` carries a pause reason and waits for a person; `stopped` ends the run and records
 * the cause, which until now only existed as free text in `lastFailure` or in the continuation goal.
 */
export const STOP_REASONS = ["user", "model", "sandbox", "budget", "error", "no-progress", "reconciled"] as const;

export type StopReasonCode = (typeof STOP_REASONS)[number];

/** What a person can do to resume; the workbench renders one button per action it has a route for. */
export type PauseAction =
  | "approve" | "deny"
  | "answer"
  | "redispatch" | "review-directly" | "ignore-worker"
  | "view-diagnostics" | "change-permission-mode"
  | "change-model"
  | "recheck-project"
  | "install-capability" | "skip-capability"
  | "add-budget";

export const PAUSE_ACTIONS: Record<PauseReasonCode, PauseAction[]> = {
  approval: ["approve", "deny"],
  question: ["answer"],
  "worker-no-result": ["redispatch", "review-directly", "ignore-worker"],
  sandbox: ["view-diagnostics", "change-permission-mode"],
  model: ["change-model"],
  "project-state": ["recheck-project"],
  capability: ["install-capability", "skip-capability"],
  budget: ["add-budget"],
};

/** The sixteen service strings written before reason codes existed, mapped onto the eight codes. */
export const LEGACY_SERVICE_TO_REASON: Record<string, PauseReasonCode> = {
  approval: "approval",
  "web-approval": "approval",
  "web-source": "approval",
  MCP: "approval",
  "worker-review": "worker-no-result",
  "review-repair": "worker-no-result",
  "worker-integration": "worker-no-result",
  "worker-approval": "worker-no-result",
  "windows-sandbox": "sandbox",
  model: "model",
  "project-state": "project-state",
  project: "project-state",
  recovery: "project-state",
  "git-backup": "project-state",
  capability: "capability",
  "git-worktree": "capability",
};

export function isPauseReasonCode(value: unknown): value is PauseReasonCode {
  return typeof value === "string" && (PAUSE_REASONS as readonly string[]).includes(value);
}

export function isStopReasonCode(value: unknown): value is StopReasonCode {
  return typeof value === "string" && (STOP_REASONS as readonly string[]).includes(value);
}

/** Maps a pre-code service string to a reason code; an unknown value stays unmapped and the invariant check flags it. */
export function reasonFromLegacyService(service: string | undefined): PauseReasonCode | undefined {
  return service ? LEGACY_SERVICE_TO_REASON[service] : undefined;
}

export function pauseActions(code: PauseReasonCode | undefined): PauseAction[] {
  return code ? PAUSE_ACTIONS[code] : [];
}
