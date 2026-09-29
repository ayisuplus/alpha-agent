import type { TaskState } from "./task-ledger";

/** Planning may inspect assigned files and public web pages, then record the plan. */
export const PLANNING_TOOL_NAMES = ["read", "grep", "alpha_input", "alpha_skill_read", "alpha_plan", "alpha_step", "alpha_expert_search", "alpha_capability_search", "alpha_search", "alpha_source", "alpha_site", "alpha_browser"] as const;

export const REVIEW_PAUSE_TOOL_NAMES = ["read", "grep"] as const;

/**
 * A task may act only after a plan is recorded (docs/plan-graph-and-expert-state-2026-09-29.md §0): until `alpha_plan`
 * records at least one step, every non-planning tool call is rejected. P3 tightens this to the three-phase graph.
 */
export function hasRecordedPlan(state: Pick<TaskState, "cognition">): boolean {
  return (state.cognition?.nodes.length ?? 0) > 0;
}

/** Source/file-writing tools a read-only node (investigate/review) may not call (§7); alpha_check stays allowed. */
export const WRITE_TOOL_NAMES = ["edit", "write", "alpha_command", "alpha_build", "alpha_document"] as const;
