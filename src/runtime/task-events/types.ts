import type { AgentMessage } from "../agent-mailbox";
import type { AgentPresetSnapshot } from "../agent-presets";
import type { PauseReasonCode, StopReasonCode } from "../pause-reasons";
import type {
  AcceptanceCriterion, CognitionState, CognitionStep, DevelopmentState, Evidence, ExecutionMode,
  GuidanceRecord, LocalPreview, RunRecord, TaskPhase, TaskState, WorkerCognition, WorkerRequestRecord,
} from "../task-ledger";
import type { WorkOrder } from "../work-orders";

/**
 * The append-only task event log (docs/cognitive-state-machine-plan-2026-09-28.md §4.1-§4.3). One event per ledger
 * mutation; `foldTask` rebuilds the state and `<id>.json` stays as a projection for readers that have not migrated.
 *
 * Payloads carry every value the reducer cannot derive purely: generated ids, timestamps and source revisions read
 * from the filesystem. That keeps `applyEvent` deterministic, so a fold reproduces the projection byte for byte.
 */

/** Who caused the event. `worker:<id>` is a subagent process writing to its parent task's log. */
export type TaskActor = "user" | "runtime" | "coordinator" | "reviewer" | `worker:${string}`;

export type TaskInstanceRecord = NonNullable<CognitionState["instances"]>[number];

/**
 * Why a subagent attempt ended. `no-result` is the case the plan calls out: the attempt finished without submitting
 * `alpha_worker_result`, which used to be indistinguishable from any other failure except by matching a message.
 * `refusal` has no producer yet — no model signal for it exists in the SDK — and is reserved for when one does.
 */
export type WorkerStopReason = "completed" | "needs-input" | "aborted" | "error" | "max-tokens" | "budget" | "refusal" | "no-result";

export interface TaskEventPayloads {
  /** Written once by `TaskLedger.create`; the payload is the initial state. */
  "task/created": { state: TaskState };
  /** Written once when a pre-event-log JSON ledger is first loaded; the payload is that file's state. */
  "task/imported": { state: TaskState; source: "legacy-json" };

  "contract/revised": {
    objective: string;
    contractVersion: number;
    historyEntry: { version: number; objective: string; revisedAt: string };
    reopenReason: string;
  };
  "criteria/set": { criteria: AcceptanceCriterion[] };
  "input/attached": { inputs: NonNullable<TaskState["inputs"]> };
  "capabilities/set": { capabilities: NonNullable<TaskState["capabilities"]> };
  "project-version/confirmed": { version: number };
  "model/set": { selector: string | null };
  "guidance/recorded": { guidance: GuidanceRecord };
  "guidance/status-changed": { id: string; status: "delivered" | "processed" };

  /** Full goal snapshot with its budget and revision, matching the plan's `goal/changed`. */
  "goal/changed": { goal: NonNullable<TaskState["goal"]> & { revision: number } };

  "phase/changed": { phase: TaskPhase; clearPause: boolean };
  "plan/submitted": Record<string, never>;
  "plan/approved": { approval: NonNullable<TaskState["planApproval"]> };
  "plan/revised": {
    input: { summary: string; candidates: string[]; steps: CognitionStep[]; reason: string; scope?: string[]; constraints?: string[]; openQuestions?: string[] };
    recordedAt: string;
  };
  /** `expectedRevision` is the board revision the caller read; a mismatch means someone else moved the step first. */
  "step/changed": { id: string; status: CognitionStep["status"]; reason: string; expectedRevision?: number; claimedBy?: string };
  "candidates/set": { candidates: string[] };

  "capability-gap/recorded": { kind: CognitionState["gaps"][number]["kind"]; description: string; recordedAt: string };
  "capability-gap/resolved": { kind: CognitionState["gaps"][number]["kind"]; description: string; resolution: string; resolvedAt: string };
  "skill-search/recorded": {
    key: string;
    gapDescription: string;
    query: string;
    error?: string;
    resultCount: number;
    proposals: Array<NonNullable<CognitionState["skillProposals"]>[number]>;
    recordedAt: string;
  };
  "skill-proposal/decided": { id: string; decision: "rejected" | "installed"; installedSkillId?: string; resolvedAt: string };

  "evidence/recorded": { evidence: Evidence };
  "preview/published": { preview: LocalPreview };
  "run/ended": { run: RunRecord };
  "source/revision-refreshed": { revision: string };
  "failure/recorded": { reason: string };
  "failure/cleared": Record<string, never>;

  "development/enabled": Record<string, never>;
  "review/recorded": { review: NonNullable<DevelopmentState["review"]> };
  "repair-attempt/recorded": Record<string, never>;

  "worker/dispatched": {
    id: string;
    orderId: string;
    mode: ExecutionMode;
    expert?: { id: string; name: string; hash: string };
    skills: Array<{ id: string; hash: string; revision: string }>;
    decisionReason?: string;
    startedAt: string;
  };
  "worker/queued": {
    attemptId: string;
    parentId?: string;
    order: WorkOrder;
    preset?: AgentPresetSnapshot;
    expert?: { id: string; name: string; hash: string };
    startedAt: string;
  };
  "worker/updated": {
    id: string;
    status: "running" | "returned" | "completed" | "blocked" | "failed" | "cancelled";
    patch: {
      workRoot?: string;
      worktreePath?: string;
      findings?: string[];
      integration?: "pending" | "merged" | "conflict";
      integrationDecision?: TaskInstanceRecord["integrationDecision"];
      skills?: WorkOrder["skillSnapshots"];
      capabilities?: WorkOrder["capabilitySnapshots"];
      cognition?: NonNullable<NonNullable<CognitionState["agents"]>[number]["cognition"]>;
    };
    endedAt?: string;
  };
  "worker-cognition/updated": { cognition: WorkerCognition };
  "worker-receipt/recorded": { receipt: NonNullable<TaskState["workerReceipts"]>[number] };
  "worker-request/recorded": { request: WorkerRequestRecord };
  "worker-request/updated": {
    id: string;
    patch: Partial<Pick<WorkerRequestRecord, "status" | "reason" | "resolutionRunId" | "approvalId" | "commandReceipt" | "installArgv" | "cwdRelative" | "availabilityPath" | "installNetwork">> & Pick<WorkerRequestRecord, "status">;
    resolvedAt?: string;
    clearResolvedAt: boolean;
  };
  "worker-run/prepared": Record<string, never>;
  "worker/finished": { id: string; status: "completed" | "blocked" | "failed" | "cancelled"; findings: string[]; endedAt: string };
  "workers/reconciled": { reason: string; endedAt: string };
  "worker-outcome/recorded": { outcome: NonNullable<TaskState["workerOutcome"]> };
  /** A subagent process is live: where it works, which pid to reap, and which model it runs. */
  "worker/activated": {
    attemptId: string;
    orderId: string;
    agentId?: string;
    pid?: number;
    workRoot?: string;
    worktreePath?: string;
    activatedAt: string;
  };
  /** The attempt's outcome, recorded whether or not the worker submitted a result. */
  "worker/result": {
    attemptId: string;
    stopReason: WorkerStopReason;
    findings: string[];
    reviewVerdict?: "pass" | "changes-requested" | "inconclusive";
    detail?: string;
    recordedAt: string;
  };
  /** A message queued for the coordinator or for one agent; the inbox is these minus the acknowledgements. */
  "worker/message-queued": { message: AgentMessage };
  "worker/message-acknowledged": { id: string; agentId: string | null; acknowledgedAt: string };

  /** Every status change carries its reason: a pause code when waiting for a person, a stop code when the run ended. */
  "status/changed":
    | { status: "complete" }
    | { status: "stopped"; reason: StopReasonCode; detail?: string }
    | { status: "active"; reopenReason: string; guidance?: GuidanceRecord }
    | { status: "needs-input"; question: string; reason?: PauseReasonCode };

  "checkpoint/started": Record<string, never>;
  "checkpoint/committed": { checkpoint: NonNullable<TaskState["checkpoint"]> };
  "checkpoint/failed": { reason: string };
}

export type TaskEventType = keyof TaskEventPayloads;

export type TaskEventOf<Type extends TaskEventType> = {
  seq: number;
  at: string;
  actor: TaskActor;
  /** The run that caused the event, when it happened inside one; lets the timeline attribute entries to a turn. */
  runId?: string;
  type: Type;
  payload: TaskEventPayloads[Type];
};

export type TaskEvent = { [Type in TaskEventType]: TaskEventOf<Type> }[TaskEventType];

/** An event as the ledger builds it, before the log assigns `seq`. */
export type TaskEventDraft<Type extends TaskEventType = TaskEventType> = Omit<TaskEventOf<Type>, "seq">;

/** What a ledger method hands to `commit`; the log stamps `seq`, `at` and `actor`. */
export type TaskEventPlan = { [Type in TaskEventType]: { type: Type; payload: TaskEventPayloads[Type] } }[TaskEventType];

/** One family of reducers; `apply.ts` merges the families into a single dispatch table. */
export type FamilyReducers = { [Type in TaskEventType]?: (state: TaskState, event: TaskEventOf<Type>) => void };
