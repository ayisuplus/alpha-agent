import type { CommandRequest } from "../../command-approval";
import type { TaskState } from "../../task-ledger";
import type { WebApproval } from "../../web-permissions";
import { InvariantError } from "../errors";
import type { FamilyReducers } from "../types";


/** Non-null because a review always records who decided; the event's `reviewer` is the same value widened to `string`. */
type Reviewer = NonNullable<CommandRequest["review"]>["reviewer"];

function requireApproval(state: TaskState, id: string): CommandRequest {
  const found = state.approvals?.find(item => item.id === id);
  if (!found) throw new InvariantError("apply/approval-unknown", `Approval ${id} was never requested`);
  return found;
}

function requireWebApproval(state: TaskState, id: string): WebApproval {
  const found = webApprovals(state).find(item => item.id === id);
  if (!found) throw new InvariantError("apply/web-approval-unknown", `Web approval ${id} was never requested`);
  return found;
}

function webApprovals(state: TaskState): WebApproval[] {
  return (state.webApprovals ??= []);
}

export const approvalReducers: FamilyReducers = {
  "approval/requested": (state, event) => {
    const p = event.payload;
    const record: CommandRequest = {
      id: p.id,
      taskId: state.id,
      cwd: p.cwd ?? "",
      argv: p.argv ?? [],
      purpose: p.purpose as CommandRequest["purpose"],
      ...(p.network !== undefined ? { network: p.network } : {}),
      status: "pending",
      createdAt: p.requestedAt,
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
      ...(p.risk !== undefined ? { risk: p.risk as CommandRequest["risk"] } : {}),
    };
    const list = (state.approvals ??= []);
    const existing = list.findIndex(item => item.id === p.id);
    if (existing >= 0) list[existing] = record; else list.push(record);
  },

  "approval/reviewed": (state, event) => {
    const { reviewer, decision, reason, reviewedAt } = event.payload;
    const record = requireApproval(state, event.payload.id);
    record.status = decision === "approved" ? "approved" : decision === "denied" ? "denied" : "pending";
    record.review = { reviewer: reviewer as Reviewer, decision, reason, at: reviewedAt };
  },

  "approval/claimed": (state, event) => {
    requireApproval(state, event.payload.id).status = "running";
  },

  "approval/finished": (state, event) => {
    const { exitCode, logPath, revision } = event.payload;
    const record = requireApproval(state, event.payload.id);
    // A receipt with no `logPath` is an aborted/errored attempt: it ends uncertain without an execution receipt.
    record.status = exitCode === 0 ? "complete" : "uncertain";
    if (logPath !== undefined && revision !== undefined) record.result = { exitCode, logPath, revision };
  },

  "web-approval/requested": (state, event) => {
    const p = event.payload;
    const record: WebApproval = {
      id: p.id,
      taskId: state.id,
      kind: p.kind,
      scope: p.scope,
      ...(p.actionId !== undefined ? { actionId: p.actionId } : {}),
      status: "pending",
      requestedAt: p.requestedAt,
    };
    const list = webApprovals(state);
    const existing = list.findIndex(item => item.id === p.id);
    if (existing >= 0) list[existing] = record; else list.push(record);
  },

  "web-approval/decided": (state, event) => {
    const { approved, decidedAt } = event.payload;
    const record = requireWebApproval(state, event.payload.id);
    record.status = approved ? (record.kind === "read" ? "granted" : "approved") : "denied";
    record.decidedAt = decidedAt;
  },

  // `grantRead` resolves a scope, not a stored id (the projection stamps its own uuid), so a grant with no prior read
  // entry folds to a scope-keyed surrogate id; the projection file remains authoritative for the real id.
  "web-approval/read-granted": (state, event) => {
    const { scope, grantedAt } = event.payload;
    const list = webApprovals(state);
    const existing = list.find(item => item.kind === "read" && item.scope === scope);
    if (existing) { existing.status = "granted"; existing.decidedAt = grantedAt; return; }
    list.push({ id: scope, taskId: state.id, kind: "read", scope, status: "granted", requestedAt: grantedAt, decidedAt: grantedAt });
  },

  "web-approval/write-begun": (state, event) => {
    requireWebApproval(state, event.payload.id).status = "running";
  },

  "web-approval/write-finished": (state, event) => {
    requireWebApproval(state, event.payload.id).status = event.payload.uncertain ? "uncertain" : "complete";
  },

  "web-approval/reconciled": (state) => {
    for (const item of webApprovals(state)) if (item.status === "running") item.status = "uncertain";
  },
};
