import { taskProfile } from "./task-profile";
import type { TaskState } from "./task-ledger";

/**
 * Acceptance gaps for a task state, independent of any ledger instance. The ledger, the invariant checks and the event
 * fold all need it, so it lives outside `task-ledger.ts` to keep `task-events` free of a runtime import cycle.
 *
 * The plan graph projects the acceptance gaps (§3.8): `plan-graph` covers unfinished nodes plus the designated-expert
 * constraint (§6.3), and `gate` covers gates without a passing, current verdict (§6.2). Criteria and evidence stay
 * independent and are checked by the review nodes.
 */
export function computeCompletionGaps(state: TaskState): string[] {
  const contractVersion = state.contractVersion ?? 1;
  const gaps = state.criteria.filter(criterion => {
    const latest = state.evidence.findLast(item => item.criterionId === criterion.id && (item.contractVersion ?? 1) === contractVersion && item.revision === state.revision && (criterion.kind !== "browser" || item.previewId === state.preview?.id));
    return !latest?.passed;
  }).map(criterion => criterion.id);
  if (taskProfile(state.taskType).acceptance === "web-preview" && (!state.preview || state.preview.revision !== state.revision)) gaps.push("local-preview");
  const nodes = state.cognition?.nodes ?? [];
  // §6.3: a user-designated expert is a graph constraint — some node that uses it must be done under the current
  // contract, whatever the task type. Work-order nodes bind their contract through the instance instead of a handoff.
  const designatedNodeDone = !state.designatedExpertId || nodes.some(node => {
    if (node.expertDecision.expertId !== state.designatedExpertId || node.status !== "done" || node.stale) return false;
    const instance = [...(state.cognition?.instances ?? [])].reverse().find(item => item.orderId === node.id);
    return (node.handoff?.contractVersion ?? instance?.contractVersion) === contractVersion;
  });
  if (nodes.some(node => node.status !== "done" && node.status !== "cancelled") || !designatedNodeDone) gaps.push("plan-graph");
  // §6.2: a gate is outstanding while the independent review is not a current pass, or a review node's verdict is
  // missing, not a pass, or expired — stale inputs (§3.5) or a contract the verdict does not bind.
  const gateOutstanding = (state.development?.enabled && (state.development.review?.verdict !== "pass" || state.development.review.revision !== state.revision || state.development.review.contractVersion !== contractVersion))
    || nodes.some(node => node.kind === "review" && node.handoff && (node.handoff.verdict !== "pass" || node.stale || node.handoff.contractVersion !== contractVersion));
  if (gateOutstanding) gaps.push("gate");
  if (state.cognition?.gaps.some(item => !item.resolvedAt)) gaps.push("capability-gap");
  if (state.workerRequests?.some(item => ["open", "awaiting-approval", "uncertain"].includes(item.status))) gaps.push("worker-request");
  if (state.cognition?.instances?.some(item => item.order && ["queued", "running", "returned"].includes(item.status))) gaps.push("worker-integration");
  return gaps;
}
