import { taskProfile } from "./task-profile";
import type { TaskState } from "./task-ledger";

/**
 * Acceptance gaps for a task state, independent of any ledger instance. The ledger, the invariant checks and the event
 * fold all need it, so it lives outside `task-ledger.ts` to keep `task-events` free of a runtime import cycle.
 */
export function computeCompletionGaps(state: TaskState): string[] {
  const gaps = state.criteria.filter(criterion => {
    const latest = state.evidence.findLast(item => item.criterionId === criterion.id && (item.contractVersion ?? 1) === (state.contractVersion ?? 1) && item.revision === state.revision && (criterion.kind !== "browser" || item.previewId === state.preview?.id));
    return !latest?.passed;
  }).map(criterion => criterion.id);
  if (taskProfile(state.taskType).acceptance === "web-preview" && (!state.preview || state.preview.revision !== state.revision)) gaps.push("local-preview");
  if (state.development?.enabled && (state.development.review?.verdict !== "pass" || state.development.review.revision !== state.revision || state.development.review.contractVersion !== (state.contractVersion ?? 1))) gaps.push("development-review");
  if (state.cognition?.gaps.some(item => !item.resolvedAt)) gaps.push("capability-gap");
  if (state.workerRequests?.some(item => ["open", "awaiting-approval", "uncertain"].includes(item.status))) gaps.push("worker-request");
  // Without subagents to dispatch, the coordinator itself works from the designated expert's persona and Skills.
  if (state.designatedExpertId && taskProfile(state.taskType).dispatch && !state.cognition?.instances?.some(item => item.expert?.id === state.designatedExpertId && item.status === "completed" && item.contractVersion === (state.contractVersion ?? 1))) gaps.push("designated-expert");
  if (state.planApproval && state.phase === "execute" && state.cognition?.steps.some(step => step.status !== "complete" && step.status !== "cancelled")) gaps.push("plan-steps");
  if (state.cognition?.instances?.some(item => item.order && ["queued", "running", "returned"].includes(item.status))) gaps.push("worker-integration");
  return gaps;
}
