import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isAllowedModelSelector } from "./model-policy";
import { excludedSourceDirectory } from "./source-review";
import { computeCompletionGaps } from "./task-completion";
import { checkTaskInvariants } from "./task-invariants";
import {
  SNAPSHOT_INTERVAL, appendEvent, appendPlannedEvent, applyEvent, eventLogPath, foldTask, latestSnapshot, readEvents,
  readTaskLog, replaceState, taskLogDir, writeSnapshot,
} from "./task-events";
import type { TaskActor, TaskEvent, TaskEventDraft, TaskEventPayloads, TaskEventPlan, WorkerStopReason } from "./task-events";
import type { AgentMessage } from "./agent-mailbox";
import type { CommandRequest } from "./command-approval";
import type { ExpertSnapshot } from "./experts";
import type { PauseReasonCode, StopReasonCode } from "./pause-reasons";
import type { WebApproval } from "./web-permissions";
import type { WorkOrder } from "./work-orders";

export type EvidenceKind = "build" | "test" | "browser" | "asset" | "preview" | "source" | "artifact";
export type TaskType = "web-product" | "code-change" | "research" | "file-work" | "general";

/** Task types whose coordinator works alone instead of dispatching subagents. */
export type PermissionMode = "ask" | "auto" | "full";
export type TaskPhase = "plan" | "plan-review" | "execute";
export interface GoalBudget { maxToolCalls: number; wallTimeMs: number; maxTotalToolCalls: number; totalWallTimeMs: number }

/** Why a continuation goal gave up; `needs-input:<code>` names the pause reason it stopped on. */
export type GoalStopReason =
  | "accepted" | "user-disabled" | "no-progress" | "cancelled" | "user-control" | "plan-review"
  | "planning-incomplete" | "budget-exhausted" | "stopped" | "hard-error" | "needs-input"
  | `needs-input:${PauseReasonCode}`;

export interface WorkspaceOrigin {
  kind: "generated" | "git" | "copy" | "direct";
  sourcePath?: string;
  snapshotFile?: string;
  initialRevision?: string;
  checks?: Array<{ name: string; command: string }>;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  kind: EvidenceKind;
}

export interface Evidence {
  id: string;
  attemptId?: string;
  criterionId: string;
  kind: EvidenceKind;
  revision: string;
  contractVersion?: number;
  previewId?: string;
  passed: boolean;
  source: string;
  contentHash?: string;
  referenceIds?: string[];
  recordedAt: string;
}

export interface LocalPreview {
  id: string;
  revision: string;
  path: string;
  url: string;
  taskId?: string;
  pid?: number;
  port?: number;
  recordedAt: string;
}

export interface RunRecord {
  model: string;
  stage?: "coordinator" | "implementation" | "review" | "worker" | "answer";
  /** The plan node this run worked inside (§3.3); every run belongs to exactly one node. */
  nodeId?: string;
  instanceId?: string;
  thinkingPolicyVersion?: number;
  contractVersion?: number;
  toolCalls: number;
  /** Latency to the model's first visible response in this run, for the eval report. */
  firstResponseMs?: number;
  compactions?: number;
  compactionFailures?: number;
  maxToolCalls: number;
  wallTimeMs: number;
  elapsedMs: number;
  childElapsedMs?: number;
  usageIncomplete?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  /** Size of the fixed prompt and tool definitions this run's session sent with every request. */
  prompt?: { systemTokens: number; toolTokens: number; tools: number; contextShare: number | null; exact: boolean };
  /** The expert's primary method that fell back to list mode this run (expert-scope §4.4 step 2). */
  skillBudgetFallback?: { id: string; reason: string };
  /** `node-switch` ends the run because the cursor moved to a node with a different expert or access (§3.6). */
  outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input" | "node-switch";
  failureReason?: string;
  recordedAt: string;
}

/** Tool calls and time the task's own work has used; answering follow-up questions does not count against it. */
export function taskBudgetUsed(runs: readonly RunRecord[] | undefined): { toolCalls: number; elapsedMs: number } {
  let toolCalls = 0;
  let elapsedMs = 0;
  for (const run of runs ?? []) {
    if (run.stage === "answer") continue;
    toolCalls += run.toolCalls;
    elapsedMs += run.elapsedMs;
  }
  return { toolCalls, elapsedMs };
}

export interface GuidanceRecord {
  id?: string;
  instruction: string;
  recordedAt: string;
  status?: "recorded" | "delivered" | "processed";
}

/**
 * Node types double as the three skeleton stages (§3.1): investigate, execute and review. A review-kind node may sit
 * inside the execute stage as an intermediate gate. The pure rules live in the dependency-free plan-kind module so
 * event reducers can share them without a module cycle.
 */
import { accessOf, type AccessLevel, type NodeHost, type PlanNodeKind } from "./plan-kind";

export { accessOf, type AccessLevel, type NodeHost, type PlanNodeKind };

/** A task-local expert the model composed (§4.3); it loads like any expert but never widens permissions. */
export interface TemporaryExpert {
  name: string;
  description: string;
  instructions: string;
  skillIds: string[];
}

/** Which expert activates in a node, and why; required on every node (§4.3). */
export interface ExpertDecision {
  /** An expert from the library; absent means no expert activates and the host works the node itself. */
  expertId?: string;
  /** A task-local expert; mutually exclusive with expertId. */
  temporaryExpert?: TemporaryExpert;
  reason: string;
}

/** What a node hands downstream (§6.1): artifacts and findings, never conversation. */
export interface PlanNodeHandoff {
  nodeId: string;
  runId: string;
  expert?: { id: string; hash: string };
  artifacts: Array<{ path: string; hash: string; kind: string }>;
  findings?: Array<{ claim: string; source: string }>;
  verdict?: "pass" | "changes-requested" | "inconclusive";
  note: string;
  unresolved: string[];
  contractVersion: number;
}

/** The node lifecycle (§3.4), derived from node events and outputs — never model-reported. */
export type PlanNodeStatus = "planned" | "ready" | "active" | "waiting" | "done" | "reopened" | "cancelled";

/**
 * A back-edge the plan declares (§3.1, §3.5): `rework` returns review findings to the execute node they came from;
 * `premise` returns to an investigate node whose premise broke. `depends` edges derive from `dependsOn` and are not
 * stored. `maxTraversals` caps automatic traversals (rework defaults to the two automatic repair rounds).
 */
export interface PlanEdge {
  from: string;
  to: string;
  kind: "rework" | "premise";
  maxTraversals?: number;
  /** How many times the runtime traversed this edge; recorded on traversal. */
  traversals?: number;
}

/** One upstream output a node consumed, snapshotted at entry so later exits can tell downstream work went stale (§3.5). */
export interface ConsumedArtifact {
  nodeId: string;
  /** The artifact path, or `finding:<n>` for an upstream finding. */
  key: string;
  hash: string;
}

export interface AgentRecord {
  id: string;
  expert?: ExpertSnapshot;
  skillIds: string[];
  skillSnapshots?: NonNullable<WorkOrder["skillSnapshots"]>;
  capabilityIds?: string[];
  capabilitySnapshots?: NonNullable<WorkOrder["capabilitySnapshots"]>;
  contextRevision?: number;
  kind: PlanNodeKind;
  orderId: string;
  lastAttemptId: string;
  status: "queued" | "running" | "returned" | "waiting-primary" | "completed" | "failed" | "cancelled";
  cognition?: { revision: number; understanding: string; findings: Array<{ text: string; evidence: string[] }>; openQuestions: string[]; nextActions: string[]; sourceRevision: string | null };
}
export interface WorkerCognition {
  revision: number;
  understanding: string;
  findings: Array<{ text: string; evidence: string[] }>;
  openQuestions: string[];
  nextActions: string[];
  sourceRevision: string | null;
  attemptId: string;
  updatedAt: string;
}
export interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  /** The skeleton stage this node fills; a review-kind node may sit inside the execute stage as a gate (§3.1). */
  phase: PlanNodeKind;
  objective: string;
  dependsOn: string[];
  /** Required on every node (§4.3): which expert activates here, and why. */
  expertDecision: ExpertDecision;
  host: NodeHost;
  /** Artifact types this node consumes and produces (§5); the handoff checks carries them. */
  consumes?: string[];
  produces?: string[];
  /** The writable scope for execute nodes on code tasks (§7). */
  ownedPaths?: string[];
  /** Review nodes only: the role that must perform the gate (§6.2). */
  gateRole?: string;
  /** Skills explicitly added on top of the activated expert's package (§4.4 step 6). */
  skillIds: string[];
  /** Reducer-owned lifecycle derived from node events and outputs (§3.4); models never report it (§1.1). */
  status: PlanNodeStatus;
  statusReason?: string;
  /** Board revision of this node; every transition bumps it and callers pass the value they read (compare-and-swap). */
  revision?: number;
  /** The execution location that claimed the node, when one did. */
  claimedBy?: string;
  /** Who runs the node and with what (§4.1): recorded with the entry, never a separate activation event. */
  activation?: {
    host: NodeHost;
    runId: string;
    access: AccessLevel;
    expert?: { id: string; name: string; hash: string };
    expertSnapshot?: ExpertSnapshot;
    temporaryExpert?: TemporaryExpert;
    /** Upstream artifacts as they stood at entry; an upstream re-exit with different hashes marks this stale (§3.5). */
    inputs?: ConsumedArtifact[];
  };
  /** The exit record once the node is done (§6.1). */
  handoff?: PlanNodeHandoff;
  /** Upstream inputs changed after this node finished: the coordinator redoes it or keeps it knowingly (§3.5). */
  stale?: boolean;
}
export interface CognitionState {
  revision: number;
  recipeVersion: number;
  summary: string;
  scope?: string[];
  constraints?: string[];
  openQuestions?: string[];
  candidates: string[];
  taskSkillIds?: string[];
  /** Proposals to save a task-local expert into the library; the user decides, like Skill proposals (§4.3). */
  expertProposals?: Array<{ id: string; temporaryExpert: TemporaryExpert; status: "pending" | "rejected" | "installed"; installedExpertId?: string; recordedAt: string; resolvedAt?: string }>;
  /** The three-stage skeleton written at task creation (§3.2); nodes fill it and cannot delete stages. */
  stages?: PlanNodeKind[];
  /** Declared back-edges (§3.5); `depends` edges live in each node's `dependsOn`. */
  edges?: PlanEdge[];
  nodes: PlanNode[];
  gaps: Array<{ kind: "method" | "tool" | "permission" | "context"; description: string; recordedAt: string; resolvedAt?: string; resolution?: string; blockingReason?: string }>;
  amendments: Array<{ revision: number; reason: string; affectedNodes: string[]; recordedAt: string }>;
  basedOnRevision?: string | null;
  skillSearches?: Array<{ key: string; gapDescription: string; query: string; resultCount: number; error?: string; recordedAt: string }>;
  skillProposals?: Array<{ id: string; key: string; name: string; description: string; source: string; revision: string; path: string; installs: number; requirements?: { tools: string[]; services: string[]; conflicts: string[] }; status: "pending" | "rejected" | "installed"; installedSkillId?: string; recordedAt: string }>;
  agents?: AgentRecord[];
  instances?: Array<{ id: string; agentId?: string; parentId?: string; orderId: string; kind: PlanNodeKind; expert?: { id: string; name: string; hash: string }; skills: NonNullable<WorkOrder["skillSnapshots"]>; contractVersion: number; cognitionRevision: number; baseRevision: string | null; status: "queued" | "running" | "returned" | "completed" | "blocked" | "failed" | "cancelled"; integration?: "pending" | "merged" | "conflict"; decisionReason?: string; integrationDecision?: { action: "integrate" | "reject"; reason: string; runId: string; contractVersion: number; sourceRevision: string | null; recordedAt: string }; workRoot?: string; worktreePath?: string; order?: WorkOrder; stopReason?: WorkerStopReason; pid?: number; activatedAt?: string; startedAt: string; endedAt?: string; findings?: string[] }>;
}
export interface DevelopmentState {
  enabled: true;
  review?: { verdict: "pass" | "changes-requested" | "inconclusive"; findings: string[]; evidence?: Array<{ path: string; excerpt: string }>; revision: string; contractVersion: number; instanceId: string; recordedAt: string };
  repairAttempts: number;
}

export interface TaskState {
  id: string;
  projectId?: string;
  projectVersion?: number;
  permissionMode?: PermissionMode;
  taskType?: TaskType;
  workspaceOrigin?: WorkspaceOrigin;
  inputs?: Array<{ id: string; name: string; path: string; mimeType: string; size?: number; sha256: string; uploadedAt: string }>;
  capabilities?: { plugins: Array<{ id: string; revision: string }>; skills: Array<{ id: string; hash: string; revision: string }> };
  objective: string;
  designatedExpertId?: string;
  contractVersion?: number;
  contractHistory?: Array<{ version: number; objective: string; revisedAt: string }>;
  guidanceHistory?: GuidanceRecord[];
  cognition?: CognitionState;
  workerCognition?: WorkerCognition;
  workerReceipts?: Array<{ id: string; attemptId: string; kind: "check"; sourceRevision: string | null; passed: boolean; path: string; recordedAt: string }>;
  workerRequests?: WorkerRequestRecord[];
  development?: DevelopmentState;
  workerOutcome?: { status: "completed" | "needs-context" | "blocked" | "failed"; findings: string[]; reviewVerdict?: "pass" | "changes-requested" | "inconclusive"; reviewEvidence?: Array<{ path: string; excerpt: string }>; requests?: Array<{ capability: string; reason: string; details: string }> };
  /** Agent mailbox as events: a recipient's inbox is `workerMessages` minus `workerMessageAcks`. */
  workerMessages?: AgentMessage[];
  workerMessageAcks?: Array<{ id: string; agentId: string | null; acknowledgedAt: string }>;
  projectRoot: string;
  criteria: AcceptanceCriterion[];
  status: "active" | "stopped" | "complete" | "needs-input";
  phase?: TaskPhase;
  planApproval?: { contractVersion: number; cognitionRevision: number; sourceRevision: string; approvedAt: string };
  /** The launch switch: "auto" approves the plan the moment it is recorded; "review" waits for the user (§0). */
  planApprovalMode?: "auto" | "review";
  goal?: { enabled: boolean; budget?: GoalBudget; noProgressRuns?: number; stopReason?: GoalStopReason; revision?: number };
  pendingQuestion?: string;
  /** Why a `needs-input` task waits; the workbench derives its resume buttons from this code (plan §4.4). */
  pauseReason?: PauseReasonCode;
  /** Why a `stopped` task stopped, instead of reading the cause back out of `lastFailure`. */
  stop?: { reason: StopReasonCode; detail?: string; stoppedAt: string };
  /** The operation latch: which run was live when the process died, so recovery knows what to reconcile. */
  operation?: { runId: string; startedAt: string; status: "running" | "finished"; finishedAt?: string };
  /** Command and exact-action approvals for one task; their files stay as the projections readers use. */
  approvals?: CommandRequest[];
  /** Web read grants and external write approvals for one task. */
  webApprovals?: WebApproval[];
  revision: string | null;
  evidence: Evidence[];
  runs?: RunRecord[];
  preview: LocalPreview | null;
  /** Summaries of what the model saw per step; the texts live in the prompt-blob store, referenced by hash. */
  stepContexts?: Array<{ stage: "coordinator" | "implementation" | "review" | "worker" | "answer"; model: string; promptHash: string; taskContextHash: string; taskContextBytes: number; systemTokens: number; toolTokens: number; contextShare: number | null; tools: number; recordedAt: string }>;
  createdAt: string;
  updatedAt: string;
  reopenReason?: string;
  lastFailure?: string;
  /** The model this task runs with ("provider/id"); absent means the workbench default. */
  modelSelector?: string;
  checkpoint?: { runId: string; codeCommits: Array<{ root: string; commit: string }>; memoryCommit: string; recordedAt: string };
  checkpointError?: string;
  checkpointStatus?: "pending" | "committed" | "failed";
}

export interface WorkerRequestRecord {
  id: string;
  agentId: string;
  runId: string;
  orderId: string;
  kind: "capability" | "dependency" | "context" | "permission";
  blockedStep: string;
  capabilityIds: string[];
  evidence?: string[];
  sourceEvidence?: Array<{ path: string; excerpt: string }>;
  recommendation?: string;
  targetEnvironment?: string;
  proposedArgv?: string[];
  network?: boolean;
  contractVersion: number;
  sourceRevision: string | null;
  status: "open" | "awaiting-approval" | "applied" | "rejected" | "uncertain";
  reason?: string;
  resolutionRunId?: string;
  approvalId?: string;
  installArgv?: string[];
  cwdRelative?: string;
  availabilityPath?: string;
  installNetwork?: boolean;
  commandReceipt?: { id: string; status: string; exitCode?: number; logPath?: string; revision?: string };
  recordedAt: string;
  resolvedAt?: string;
}

/**
 * The launch switch for tasks recorded before it was stored: a task sitting in the plan lane was launched with review,
 * anything else was launched with auto approval. Legacy tasks keep behaving as they did.
 */
export function planApprovalModeOf(state: Pick<TaskState, "planApprovalMode" | "phase">): "auto" | "review" {
  return state.planApprovalMode ?? (state.phase === "plan" || state.phase === "plan-review" ? "review" : "auto");
}


async function listSourceFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedSourceDirectory(entry.name, directory === root)) files.push(...await listSourceFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  return files;
}

export async function fingerprintSource(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot);
  const files = (await listSourceFiles(root)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = await readFile(join(root, file));
    hash.update(file);
    hash.update("\0");
    hash.update(String(contents.length));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export class TaskLedger {
  /** Commits for one task file are serialized in-process; the log lock serializes them across processes. */
  private static readonly commitQueues = new Map<string, Promise<unknown>>();
  private readonly logDir: string;
  private seq: number;
  /** Who acts on this task; the log records it so a replay can tell the runtime from the coordinator and the workers. */
  actor: TaskActor = "runtime";
  /** The run currently writing events, so the timeline can attribute durable entries to a turn. */
  runId: string | null = null;

  private constructor(readonly file: string, readonly state: TaskState, seq: number) {
    this.logDir = taskLogDir(file);
    this.seq = seq;
  }

  /** Marks this handle as writing events for one run, so the timeline can attribute them to a turn. */
  bindRun(runId: string, actor: TaskActor = "coordinator"): this {
    this.runId = runId;
    this.actor = actor;
    return this;
  }

  static async create(dataRoot: string, input: {
    objective: string;
    designatedExpertId?: string;
    projectRoot: string;
    criteria: AcceptanceCriterion[];
    modelSelector?: string;
    taskType?: TaskType;
    workspaceOrigin?: WorkspaceOrigin;
    inputs?: TaskState["inputs"];
    capabilities?: TaskState["capabilities"];
    projectId?: string;
    projectVersion?: number;
    permissionMode?: PermissionMode;
    startMode?: "plan" | "execute";
    continueUntilAccepted?: boolean;
    goalBudget?: GoalBudget;
  }): Promise<TaskLedger> {
    if (!input.objective.trim()) throw new Error("Task objective is required");
    if (input.modelSelector && !isAllowedModelSelector(input.modelSelector)) throw new Error(`Model is not supported: ${input.modelSelector}`);
    if ((input.criteria.length === 0 && input.taskType !== "general") || new Set(input.criteria.map(item => item.id)).size !== input.criteria.length) {
      throw new Error("Criteria must be unique and nonempty except for general tasks");
    }
    const projectRoot = resolve(input.projectRoot);
    if (!(await stat(projectRoot)).isDirectory()) throw new Error("Project root must be a directory");
    const now = new Date().toISOString();
    const id = randomUUID();
    const file = join(resolve(dataRoot), "tasks", `${id}.json`);
    const state: TaskState = {
      id,
      ...(input.projectId ? { projectId: input.projectId, projectVersion: input.projectVersion, permissionMode: input.permissionMode ?? "ask" } : {}),
      taskType: input.taskType ?? "web-product",
      workspaceOrigin: input.workspaceOrigin ?? { kind: "generated" },
      ...(input.inputs?.length ? { inputs: input.inputs } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      objective: input.objective.trim(),
      ...(input.designatedExpertId ? { designatedExpertId: input.designatedExpertId } : {}),
      contractVersion: 1,
      contractHistory: [],
      guidanceHistory: [],
      cognition: { revision: 1, recipeVersion: 1, summary: input.objective.trim(), candidates: [], nodes: [], gaps: [], amendments: [] },
      projectRoot,
      criteria: input.criteria,
      status: "active",
      // Every task starts in the plan lane. "execute" (自动批准) approves the plan the moment it is recorded and the
      // run continues; "plan" (等待审批) stops for the user's review. The plan-first guard holds either way.
      phase: "plan",
      planApprovalMode: input.startMode === "plan" ? "review" : "auto",
      goal: { enabled: input.continueUntilAccepted ?? false, ...(input.goalBudget ? { budget: input.goalBudget } : {}) },
      revision: await fingerprintSource(projectRoot),
      evidence: [],
      runs: [],
      preview: null,
      createdAt: now,
      updatedAt: now,
      ...(input.modelSelector ? { modelSelector: input.modelSelector } : {}),
    };
    const ledger = new TaskLedger(file, state, 0);
    await ledger.commit(() => ({ type: "task/created", payload: { state } }));
    // The skeleton is runtime-owned (§3.2): every task starts with the three stages; plans fill them, never delete them.
    await ledger.commit(() => ({ type: "graph/skeleton-created", payload: { stages: ["investigate", "execute", "review"] } }));
    return ledger;
  }

  /** Folds the task's event log. A ledger that predates the log is imported once, without rewriting the JSON file. */
  static async load(file: string): Promise<TaskLedger> {
    const path = resolve(file);
    const logged = await readTaskLog(taskLogDir(path));
    if (!logged) return TaskLedger.importLegacy(path);
    return new TaskLedger(path, logged.state, logged.seq);
  }

  private static async importLegacy(path: string): Promise<TaskLedger> {
    const contents = await readFile(path, "utf8");
    await copyFile(path, `${path}.pre-events.bak`, constants.COPYFILE_EXCL).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const draft: TaskEventDraft = {
      at: new Date().toISOString(), actor: "runtime", type: "task/imported",
      payload: { state: JSON.parse(contents) as TaskState, source: "legacy-json" },
    };
    const event = await appendEvent(taskLogDir(path), draft, 0);
    // Folding the origin event normalizes pre-code fields, so the in-memory state always equals the log.
    return new TaskLedger(path, foldTask([event]), event.seq);
  }

  /** Last sequence number the log holds; appends are compare-and-swap against it. */
  get eventSeq(): number { return this.seq; }

  get eventsFile(): string { return eventLogPath(this.logDir); }

  async refreshRevision(): Promise<boolean> {
    this.assertActive();
    const revision = await fingerprintSource(this.state.projectRoot);
    if (revision === this.state.revision) return false;
    await this.commit(() => ({ type: "source/revision-refreshed", payload: { revision } }));
    return true;
  }

  async setCriteria(criteria: AcceptanceCriterion[]): Promise<void> {
    await this.commit(() => ({ type: "criteria/set", payload: { criteria } }));
  }

  async addInputs(inputs: NonNullable<TaskState["inputs"]>): Promise<void> {
    await this.commit(() => ({ type: "input/attached", payload: { inputs } }));
  }

  async setCapabilities(capabilities: NonNullable<TaskState["capabilities"]>): Promise<void> {
    await this.commit(() => ({ type: "capabilities/set", payload: { capabilities } }));
  }

  async confirmProjectVersion(version: number): Promise<void> {
    await this.commit(() => ({ type: "project-version/confirmed", payload: { version } }));
  }

  async recordEvidence(input: Omit<Evidence, "id" | "recordedAt">): Promise<Evidence> {
    let evidence!: Evidence;
    await this.commit(() => {
      evidence = { ...input, contractVersion: this.state.contractVersion ?? 1, id: randomUUID(), recordedAt: new Date().toISOString() };
      return { type: "evidence/recorded", payload: { evidence } };
    });
    return evidence;
  }

  async recordPreview(input: Omit<LocalPreview, "recordedAt">): Promise<void> {
    await this.commit(() => ({ type: "preview/published", payload: { preview: { ...input, recordedAt: new Date().toISOString() } } }));
  }

  completionGaps(): string[] {
    return computeCompletionGaps(this.state);
  }

  async setGoal(enabled: boolean, budget?: GoalBudget): Promise<void> {
    await this.commit(() => {
      if (this.state.status === "complete") throw new Error("Completed task cannot change continuation");
      const goal: NonNullable<TaskState["goal"]> & { revision: number } = {
        ...this.state.goal, enabled, ...(enabled && !this.state.goal?.budget && budget ? { budget } : {}),
        noProgressRuns: 0, stopReason: enabled ? undefined : "user-disabled", revision: (this.state.goal?.revision ?? 0) + 1,
      };
      return { type: "goal/changed", payload: { goal } };
    });
  }

  async setGoalProgress(noProgressRuns: number, stopReason?: GoalStopReason): Promise<void> {
    await this.commit(() => ({
      type: "goal/changed",
      payload: { goal: { ...this.state.goal, enabled: this.state.goal?.enabled ?? false, noProgressRuns, stopReason, revision: (this.state.goal?.revision ?? 0) + 1 } },
    }));
  }

  async enterPlan(): Promise<void> {
    await this.commit(() => ({ type: "phase/changed", payload: { phase: "plan", clearPause: true } }));
  }

  async submitPlanForReview(): Promise<void> {
    await this.commit(() => ({ type: "plan/submitted", payload: {} }));
  }

  async approvePlan(expected: { contractVersion: number; cognitionRevision: number; sourceRevision: string }): Promise<void> {
    // The reducer repeats the state guards; they stay here so the fingerprint read cannot change which error wins.
    if (this.state.phase !== "plan-review" || this.state.status !== "active") throw new Error("Task has no plan awaiting review");
    if (expected.contractVersion !== (this.state.contractVersion ?? 1) || expected.cognitionRevision !== this.state.cognition?.revision || expected.sourceRevision !== this.state.revision || await fingerprintSource(this.state.projectRoot) !== this.state.revision) throw new Error("Plan or project changed; review the current version before executing");
    await this.commit(() => ({ type: "plan/approved", payload: { approval: { ...expected, approvedAt: new Date().toISOString() } } }));
  }

  /** Cursor entry (§3.3): the runtime moves into a ready node; its type decides access, its decision the expert (§3.6). */
  async enterNode(input: { nodeId: string; host: NodeHost; runId: string; expert?: ExpertSnapshot; temporaryExpert?: TemporaryExpert }): Promise<void> {
    const node = this.state.cognition?.nodes.find(item => item.id === input.nodeId);
    if (!node) throw new Error(`计划中没有节点：${input.nodeId}`);
    await this.commit(() => ({
      type: "node/entered",
      payload: {
        nodeId: input.nodeId, host: input.host, runId: input.runId, access: accessOf(node.kind),
        ...(input.expert ? { expert: { id: input.expert.id, name: input.expert.name, hash: input.expert.hash }, expertSnapshot: input.expert } : {}),
        ...(input.temporaryExpert ? { temporaryExpert: input.temporaryExpert } : {}),
        startedAt: new Date().toISOString(),
      },
    }));
  }

  /**
   * Exit a node with its handoff record (§6.1). The exit conditions are runtime-checked (§3.4): findings with sources
   * for investigation, declared artifacts with matching hashes for execution, a bound verdict for review. Status is
   * derived from this record; models never report it directly.
   */
  async exitNode(input: { nodeId: string; runId: string; expert?: { id: string; hash: string }; artifacts: PlanNodeHandoff["artifacts"]; findings?: PlanNodeHandoff["findings"]; verdict?: PlanNodeHandoff["verdict"]; note: string; unresolved: string[] }): Promise<void> {
    const node = this.state.cognition?.nodes.find(item => item.id === input.nodeId);
    if (!node) throw new Error(`计划中没有节点：${input.nodeId}`);
    if (node.status === "done" || node.status === "cancelled") throw new Error(`节点已结束：${input.nodeId}`);
    // A dispatched node belongs to its work order: only the order's result can close it, so a plan-side exit can
    // never forge acceptance for delegated work.
    if (this.state.cognition?.instances?.some(instance => instance.orderId === input.nodeId)) throw new Error(`节点 ${input.nodeId} 已派发给工单，退出由工单结果决定`);
    if (!input.note.trim()) throw new Error("交接记录必须说明做了什么、哪些待核验");
    if (node.kind === "investigate") {
      if (!input.findings?.length || input.findings.some(item => !item.claim.trim() || !item.source.trim())) throw new Error("调查节点的发现必须逐条带依据（文件片段、网页来源或用户素材）");
    }
    if (node.kind === "execute") {
      const produced = new Set(input.artifacts.map(item => item.kind));
      const missing = (node.produces ?? []).find(kind => !produced.has(kind));
      if (missing) throw new Error(`执行节点缺少声明的产物：${missing}`);
      for (const artifact of input.artifacts) {
        const path = resolve(this.state.projectRoot, artifact.path);
        const contents = await readFile(path).catch(() => null);
        if (!contents || createHash("sha256").update(contents).digest("hex") !== artifact.hash) throw new Error(`交接产物不存在或哈希不符：${artifact.path}`);
      }
    }
    if (node.kind === "review") {
      if (!input.verdict) throw new Error("审查节点必须给出 gate 结论");
      if (!input.findings?.length || input.findings.some(item => !item.claim.trim() || !item.source.trim())) throw new Error("审查结论必须引用产物或源码原文");
    }
    await this.commit(() => ({
      type: "node/exited",
      payload: {
        nodeId: input.nodeId, runId: input.runId, ...(input.expert ? { expert: input.expert } : {}),
        artifacts: input.artifacts, ...(input.findings ? { findings: input.findings } : {}), ...(input.verdict ? { verdict: input.verdict } : {}),
        note: input.note, unresolved: input.unresolved, contractVersion: this.state.contractVersion ?? 1,
        exitedAt: new Date().toISOString(),
      },
    }));
    // §3.5: a changes-requested verdict walks the plan's rework edge automatically, up to its cap (the two automatic
    // repair rounds by default); past the cap the task pauses for the user instead of looping.
    if (input.verdict === "changes-requested") {
      const edge = this.state.cognition?.edges?.find(item => item.kind === "rework" && item.from === input.nodeId);
      if (edge) {
        const traversals = edge.traversals ?? 0;
        const maximum = edge.maxTraversals ?? 2;
        if (traversals < maximum) await this.reopenNode({ nodeId: edge.to, edge: "rework", sourceNodeId: input.nodeId, reason: `审查退回修改：${input.note}` });
        else await this.needInput(`审查已连续退回 ${traversals + 1} 轮，等待用户决定如何继续`, "question");
      }
    }
  }

  /**
   * Reopen a node (§3.5): walk a declared `rework`/`premise` back-edge from a source node, or redo a node marked
   * stale because its upstream inputs changed. The reopened node re-enters after this and its exit re-derives what
   * downstream work is stale.
   */
  async reopenNode(input: { nodeId: string; edge?: "rework" | "premise"; sourceNodeId?: string; reason: string }): Promise<void> {
    await this.commit(() => ({
      type: "node/reopened",
      payload: { nodeId: input.nodeId, ...(input.edge ? { edge: input.edge } : {}), ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}), reason: input.reason, recordedAt: new Date().toISOString() },
    }));
  }

  /** A node pauses here (§3.5): the pause code hangs on the node, and resuming returns to it. */
  async waitNode(nodeId: string, pause: PauseReasonCode): Promise<void> {
    await this.commit(() => ({ type: "node/waiting", payload: { nodeId, pause } }));
  }

  /**
   * Propose saving a task-local expert into the library (§4.3): it stays task-local until the user approves, exactly
   * like a Skill proposal.
   */
  async proposeTemporaryExpert(temporaryExpert: TemporaryExpert): Promise<string> {
    let id!: string;
    await this.commit(() => {
      id = randomUUID();
      return { type: "expert-proposal/recorded", payload: { proposal: { id, temporaryExpert, status: "pending", recordedAt: new Date().toISOString() } } };
    });
    return id;
  }

  async decideExpertProposal(id: string, decision: "installed" | "rejected", installedExpertId?: string): Promise<void> {
    await this.commit(() => ({ type: "expert-proposal/decided", payload: { id, decision, ...(installedExpertId ? { installedExpertId } : {}), resolvedAt: new Date().toISOString() } }));
  }

  async enableDevelopmentWorkflow(): Promise<void> {
    if (this.state.development?.enabled) return;
    await this.commit(() => ({ type: "development/enabled", payload: {} }));
  }

  async setInitialCandidates(ids: string[]): Promise<void> {
    const cognition = this.state.cognition;
    if (!cognition || cognition.revision !== 1 || cognition.candidates.length || (!ids.length && !this.state.designatedExpertId)) return;
    await this.commit(() => ({ type: "candidates/set", payload: { candidates: ids } }));
  }

  async reviseCognition(input: { summary: string; candidates: string[]; nodes: PlanNode[]; edges?: PlanEdge[]; reason: string; scope?: string[]; constraints?: string[]; openQuestions?: string[] }): Promise<void> {
    await this.commit(() => ({ type: "plan/revised", payload: { input, recordedAt: new Date().toISOString() } }));
    if (planApprovalModeOf(this.state) !== "auto" || !this.state.cognition?.nodes.length) return;
    // 计划自动批准: the recorded plan is approved at once, so the same run moves into execution without a review
    // pause. Anything that blocks approval (empty plan, a source fingerprint that moved) leaves the task in the review
    // lane instead of executing an unapproved plan, and the reason is recorded.
    try {
      if (this.state.phase === "plan") await this.submitPlanForReview();
      if (this.state.phase === "plan-review") {
        await this.approvePlan({ contractVersion: this.state.contractVersion ?? 1, cognitionRevision: this.state.cognition.revision, sourceRevision: this.state.revision ?? "" });
      }
    } catch (error) {
      await this.recordFailure(`计划自动批准未完成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async recordCapabilityGap(kind: CognitionState["gaps"][number]["kind"], description: string): Promise<void> {
    this.assertActive();
    if (this.state.cognition?.gaps.some(item => item.kind === kind && item.description === description.trim())) return;
    await this.commit(() => ({ type: "capability-gap/recorded", payload: { kind, description, recordedAt: new Date().toISOString() } }));
  }

  async resolveCapabilityGap(kind: CognitionState["gaps"][number]["kind"], description: string, resolution: string): Promise<void> {
    await this.commit(() => ({ type: "capability-gap/resolved", payload: { kind, description, resolution, resolvedAt: new Date().toISOString() } }));
  }

  async recordSkillSearch(input: { key: string; gapDescription: string; query: string; error?: string; proposals: Array<{ name: string; description: string; source: string; revision: string; path: string; installs: number; requirements?: { tools: string[]; services: string[]; conflicts: string[] } }> }): Promise<void> {
    this.assertActive();
    if (this.state.cognition?.skillSearches?.some(item => item.key === input.key)) return;
    await this.commit(() => {
      const recordedAt = new Date().toISOString();
      const proposals = input.proposals.map(item => ({ ...item, key: input.key, id: randomUUID(), status: "pending" as const, recordedAt }));
      return { type: "skill-search/recorded", payload: { key: input.key, gapDescription: input.gapDescription, query: input.query, ...(input.error ? { error: input.error } : {}), resultCount: input.proposals.length, proposals, recordedAt } };
    });
  }

  async decideSkillProposal(id: string, decision: "rejected" | "installed", installedSkillId?: string): Promise<void> {
    await this.commit(() => ({ type: "skill-proposal/decided", payload: { id, decision, ...(installedSkillId ? { installedSkillId } : {}), resolvedAt: new Date().toISOString() } }));
  }

  async recordDispatch(input: { id: string; orderId: string; kind: PlanNodeKind; expert?: { id: string; name: string; hash: string }; skills: Array<{ id: string; hash: string; revision: string }>; decisionReason?: string }): Promise<void> {
    this.assertActive();
    if (this.state.cognition?.instances?.some(item => item.id === input.id)) return;
    await this.commit(() => ({ type: "worker/dispatched", payload: { ...input, startedAt: new Date().toISOString() } }));
  }

  async queueWorker(input: { id: string; parentId?: string; order: WorkOrder; expert?: { id: string; name: string; hash: string } }): Promise<void> {
    const { expert: expertSnapshot, ...order } = input.order;
    await this.commit(() => ({
      type: "worker/queued",
      payload: { attemptId: input.id, ...(input.parentId ? { parentId: input.parentId } : {}), order, ...(expertSnapshot ? { expertSnapshot } : {}), ...(input.expert ? { expert: input.expert } : {}), startedAt: new Date().toISOString() },
    }));
    // One subagent maps to one node (§3.3): the first attempt enters the node and records its activation with the
    // expert snapshot (§4.1). Continuations of an entered node do not re-enter.
    const node = this.state.cognition?.nodes.find(item => item.id === order.id);
    if (node && ["planned", "ready", "reopened"].includes(node.status)) {
      await this.enterNode({ nodeId: node.id, host: "worker", runId: input.id, ...(expertSnapshot ? { expert: expertSnapshot } : {}) });
    }
  }

  async updateWorker(id: string, status: "running" | "returned" | "completed" | "blocked" | "failed" | "cancelled", patch: { workRoot?: string; worktreePath?: string; findings?: string[]; integration?: "pending" | "merged" | "conflict"; integrationDecision?: NonNullable<CognitionState["instances"]>[number]["integrationDecision"]; skills?: NonNullable<WorkOrder["skillSnapshots"]>; capabilities?: NonNullable<WorkOrder["capabilitySnapshots"]>; cognition?: AgentRecord["cognition"] } = {}): Promise<void> {
    await this.commit(() => {
      const instance = this.state.cognition?.instances?.find(item => item.id === id);
      if (!instance || !instance.order) throw new Error("Worker attempt not found");
      if (["completed", "blocked", "failed", "cancelled"].includes(instance.status)) return null;
      return { type: "worker/updated", payload: { id, status, patch, ...(status !== "running" ? { endedAt: new Date().toISOString() } : {}) } };
    });
  }

  async updateWorkerCognition(input: Omit<WorkerCognition, "revision" | "sourceRevision" | "updatedAt">): Promise<WorkerCognition> {
    this.assertActive();
    const sourceRevision = await fingerprintSource(this.state.projectRoot);
    let cognition!: WorkerCognition;
    await this.commit(() => {
      cognition = { ...input, revision: (this.state.workerCognition?.revision ?? 0) + 1, sourceRevision, updatedAt: new Date().toISOString() };
      return { type: "worker-cognition/updated", payload: { cognition } };
    });
    return cognition;
  }

  async recordWorkerCheckReceipt(input: { attemptId: string; sourceRevision: string | null; passed: boolean; path: string }): Promise<string> {
    let receipt!: NonNullable<TaskState["workerReceipts"]>[number];
    await this.commit(() => {
      receipt = { id: randomUUID(), ...input, kind: "check", recordedAt: new Date().toISOString() };
      return { type: "worker-receipt/recorded", payload: { receipt } };
    });
    return receipt.id;
  }

  async recordWorkerRequest(input: Omit<WorkerRequestRecord, "status" | "recordedAt" | "reason" | "resolutionRunId" | "approvalId" | "commandReceipt" | "resolvedAt">): Promise<WorkerRequestRecord> {
    const existing = this.state.workerRequests?.find(item => item.id === input.id);
    if (existing) {
      for (const key of ["agentId", "runId", "orderId", "kind", "blockedStep", "contractVersion", "sourceRevision"] as const) if (existing[key] !== input[key]) throw new Error("Worker request ID was reused");
      return existing;
    }
    let request!: WorkerRequestRecord;
    await this.commit(() => {
      request = { ...input, capabilityIds: [...input.capabilityIds], status: "open", recordedAt: new Date().toISOString() };
      return { type: "worker-request/recorded", payload: { request } };
    });
    return request;
  }

  async updateWorkerRequest(id: string, patch: Pick<WorkerRequestRecord, "status"> & Partial<Pick<WorkerRequestRecord, "reason" | "resolutionRunId" | "approvalId" | "commandReceipt" | "installArgv" | "cwdRelative" | "availabilityPath" | "installNetwork">>): Promise<WorkerRequestRecord> {
    await this.commit(() => {
      const request = this.state.workerRequests?.find(item => item.id === id);
      if (!request) throw new Error("Worker request not found");
      if (["applied", "rejected"].includes(request.status)) throw new Error("Worker request is already resolved");
      const resolvedAt = ["applied", "rejected", "uncertain"].includes(patch.status) ? new Date().toISOString() : undefined;
      return { type: "worker-request/updated", payload: { id, patch, ...(resolvedAt ? { resolvedAt } : {}), clearResolvedAt: !resolvedAt && request.status === "uncertain" } };
    });
    const updated = this.state.workerRequests?.find(item => item.id === id);
    if (!updated) throw new Error("Worker request not found");
    return updated;
  }

  async prepareWorkerRun(): Promise<void> {
    await this.commit(() => ({ type: "worker-run/prepared", payload: {} }));
  }

  async finishDispatch(id: string, status: "completed" | "blocked" | "failed" | "cancelled", findings: string[] = []): Promise<void> {
    await this.commit(() => {
      const instance = this.state.cognition?.instances?.find(item => item.id === id);
      if (!instance || instance.status !== "running") return null;
      return { type: "worker/finished", payload: { id, status, findings, endedAt: new Date().toISOString() } };
    });
  }

  async reconcileRunningInstances(reason: string): Promise<void> {
    // One event stamps the whole batch: a reconciliation is a single moment, not one per attempt.
    await this.commit(() => (this.state.cognition?.instances?.some(item => item.status === "running" || item.status === "queued")
      ? { type: "workers/reconciled", payload: { reason, endedAt: new Date().toISOString() } }
      : null));
  }

  /** The operation latch: records which run is live so a restart knows what to reconcile. */
  async recordOperationStarted(runId: string, startedAt: string): Promise<void> {
    await this.commit(() => (this.state.operation?.status === "running" && this.state.operation.runId === runId
      ? null
      : { type: "operation/started", payload: { runId, startedAt } }));
  }

  async recordOperationFinished(runId: string, finishedAt: string): Promise<void> {
    await this.commit(() => (this.state.operation?.runId === runId && this.state.operation.status === "running"
      ? { type: "operation/finished", payload: { runId, finishedAt } }
      : null));
  }

  /** A subagent process is live; the pid lets recovery reap an orphan after a hard kill. */
  async recordWorkerActivation(input: Omit<TaskEventPayloads["worker/activated"], "activatedAt">): Promise<void> {
    await this.commit(() => ({ type: "worker/activated", payload: { ...input, activatedAt: new Date().toISOString() } }));
  }

  /** The attempt's outcome, recorded even when the worker never submitted a result. */
  async recordWorkerResult(input: Omit<TaskEventPayloads["worker/result"], "recordedAt">): Promise<void> {
    await this.commit(() => ({ type: "worker/result", payload: { ...input, recordedAt: new Date().toISOString() } }));
  }

  async recordWorkerMessage(message: AgentMessage): Promise<void> {
    await this.commit(() => ({ type: "worker/message-queued", payload: { message } }));
  }

  async acknowledgeWorkerMessage(id: string, agentId: string | null): Promise<void> {
    await this.commit(() => (this.state.workerMessageAcks?.some(ack => ack.id === id && ack.agentId === agentId)
      ? null
      : { type: "worker/message-acknowledged", payload: { id, agentId, acknowledgedAt: new Date().toISOString() } }));
  }

  async recordDevelopmentReview(input: { verdict: NonNullable<DevelopmentState["review"]>["verdict"]; findings: string[]; evidence?: Array<{ path: string; excerpt: string }>; instanceId: string; expectedRevision?: string; expectedContractVersion?: number }): Promise<void> {
    this.assertActive();
    if (!this.state.development?.enabled || !this.state.revision || !input.instanceId) throw new Error("开发审查状态无效");
    if (input.expectedRevision && (this.state.revision !== input.expectedRevision || await fingerprintSource(this.state.projectRoot) !== input.expectedRevision)) throw new Error("Reviewed source version changed");
    if (input.expectedContractVersion && (this.state.contractVersion ?? 1) !== input.expectedContractVersion) throw new Error("Reviewed task contract changed");
    const { expectedRevision: _revision, expectedContractVersion: _contract, ...review } = input;
    await this.commit(() => ({
      type: "review/recorded",
      payload: { review: { ...review, findings: input.findings.map(item => item.trim()).filter(Boolean), revision: this.state.revision!, contractVersion: this.state.contractVersion ?? 1, recordedAt: new Date().toISOString() } },
    }));
  }

  async recordRepairAttempt(): Promise<void> {
    await this.commit(() => ({ type: "repair-attempt/recorded", payload: {} }));
  }

  async recordWorkerOutcome(input: NonNullable<TaskState["workerOutcome"]>): Promise<void> {
    await this.commit(() => ({ type: "worker-outcome/recorded", payload: { outcome: input } }));
  }

  async complete(): Promise<void> {
    this.assertActive();
    if (this.state.phase !== "execute" && this.state.phase !== undefined) throw new Error("Task plan is not approved for execution");
    if (await fingerprintSource(this.state.projectRoot) !== this.state.revision) throw new Error("Task source changed before completion");
    await this.commit(() => ({ type: "status/changed", payload: { status: "complete" } }));
  }

  async reopen(reason: string): Promise<void> {
    await this.commit(() => ({ type: "status/changed", payload: { status: "active", reopenReason: reason.trim() } }));
  }

  async reviseObjective(objective: string): Promise<void> {
    await this.commit(() => {
      const version = this.state.contractVersion ?? 1;
      return {
        type: "contract/revised",
        payload: {
          objective: objective.trim(),
          contractVersion: version + 1,
          historyEntry: { version, objective: this.state.objective, revisedAt: new Date().toISOString() },
          reopenReason: "User revised the task objective",
        },
      };
    });
  }

  async resume(reason: string): Promise<void> {
    await this.commit(() => ({
      type: "status/changed",
      payload: { status: "active", reopenReason: reason.trim(), guidance: { instruction: reason.trim(), recordedAt: new Date().toISOString() } },
    }));
  }

  async recordGuidance(instruction: string): Promise<string> {
    let id = "";
    await this.commit(() => {
      id = randomUUID();
      return { type: "guidance/recorded", payload: { guidance: { id, instruction: instruction.trim(), recordedAt: new Date().toISOString(), status: "recorded" } } };
    });
    return id;
  }

  async recordCheckpointStart(): Promise<void> {
    await this.commit(() => ({ type: "checkpoint/started", payload: {} }));
  }

  async recordCheckpoint(checkpoint: NonNullable<TaskState["checkpoint"]>): Promise<void> {
    await this.commit(() => (this.state.checkpoint?.runId === checkpoint.runId && this.state.checkpoint.memoryCommit === checkpoint.memoryCommit && this.state.checkpointStatus === "committed"
      ? null
      : { type: "checkpoint/committed", payload: { checkpoint } }));
  }

  async recordCheckpointFailure(reason: string): Promise<void> {
    await this.commit(() => ({ type: "checkpoint/failed", payload: { reason } }));
  }

  async setGuidanceStatus(id: string, status: "delivered" | "processed"): Promise<void> {
    await this.commit(() => {
      const guidance = this.state.guidanceHistory?.find(item => item.id === id);
      if (!guidance) throw new Error("Guidance not found");
      if (guidance.status === "processed" || guidance.status === status) return null;
      return { type: "guidance/status-changed", payload: { id, status } };
    });
  }

  async setModel(selector: string | null): Promise<void> {
    if (selector && !isAllowedModelSelector(selector)) throw new Error(`Model is not supported: ${selector}`);
    await this.commit(() => ({ type: "model/set", payload: { selector } }));
  }

  async recordFailure(reason: string): Promise<void> {
    await this.commit(() => ({ type: "failure/recorded", payload: { reason } }));
  }

  async clearFailure(): Promise<void> {
    await this.commit(() => (this.state.lastFailure ? { type: "failure/cleared", payload: {} } : null));
  }

  /** Records what the model saw in one step; the task context text itself is stored by the caller in the blob store. */
  async recordStepContext(input: Omit<TaskEventPayloads["step/context"], "recordedAt">): Promise<void> {
    await this.commit(() => ({ type: "step/context", payload: { ...input, recordedAt: new Date().toISOString() } }));
  }

  async recordRun(input: Omit<RunRecord, "recordedAt">): Promise<void> {
    await this.commit(() => ({ type: "run/ended", payload: { run: { ...input, contractVersion: this.state.contractVersion ?? 1, recordedAt: new Date().toISOString() } } }));
  }

  async stop(reason: StopReasonCode, detail?: string): Promise<void> {
    await this.commit(() => ({ type: "status/changed", payload: { status: "stopped", reason, ...(detail ? { detail } : {}) } }));
  }

  async needInput(question: string, reason?: PauseReasonCode): Promise<void> {
    await this.commit(() => ({ type: "status/changed", payload: { status: "needs-input", question, ...(reason ? { reason } : {}) } }));
    // The pause hangs on the node this run is inside (§3.5); resuming returns to the same node.
    const active = this.state.cognition?.nodes.find(node => node.status === "active" && node.activation?.runId === this.runId);
    if (active && reason) await this.waitNode(active.id, reason);
  }

  private assertActive(): void {
    if (this.state.status !== "active") throw new Error(`Task is ${this.state.status}`);
  }

  /**
   * Validate → append → apply → project. Commits for one task file are serialized in-process and, across processes, by
   * the log lock: planning happens inside that lock, so a writer that finds the log moved on re-folds and re-plans
   * there instead of losing a retry race or overwriting the winner's events.
   */
  private commit(plan: () => TaskEventPlan | null): Promise<TaskEvent | null> {
    const prior = TaskLedger.commitQueues.get(this.file) ?? Promise.resolve();
    const work = prior.then(() => this.appendPlanned(plan), () => this.appendPlanned(plan));
    TaskLedger.commitQueues.set(this.file, work);
    void work.then(
      () => { if (TaskLedger.commitQueues.get(this.file) === work) TaskLedger.commitQueues.delete(this.file); },
      () => { if (TaskLedger.commitQueues.get(this.file) === work) TaskLedger.commitQueues.delete(this.file); },
    );
    return work;
  }

  private async appendPlanned(plan: () => TaskEventPlan | null): Promise<TaskEvent | null> {
    return appendPlannedEvent(
      this.logDir,
      this.seq,
      async () => {
        const draft = plan();
        if (!draft) return null;
        const event = { ...draft, at: new Date().toISOString(), actor: this.actor, ...(this.runId ? { runId: this.runId } : {}) } as TaskEvent;
        // Dry run: the reducer's guards reject the event before anything reaches the log.
        applyEvent(structuredClone(this.state), event);
        return event;
      },
      async () => { await this.reload(); return this.seq; },
      async appended => {
        // Applying and projecting inside the log lock keeps the JSON file from ever lagging behind the log tip.
        applyEvent(this.state, appended);
        this.seq = appended.seq;
        await this.save();
        if (process.env.ALPHA_TASK_INVARIANTS) {
          for (const violation of checkTaskInvariants(this.state)) console.warn(`ALPHA_INVARIANT ${this.state.id} ${violation.code}: ${violation.message}`);
        }
      },
    );
  }

  /** Re-folds the log after another writer won the sequence compare-and-swap. */
  private async reload(): Promise<void> {
    const snapshot = await latestSnapshot(this.logDir);
    const events = await readEvents(this.logDir, snapshot?.offset ?? 0);
    const state = foldTask(events, snapshot ? { base: { seq: snapshot.seq, state: snapshot.state } } : {});
    replaceState(this.state, state);
    this.seq = events.length ? events[events.length - 1].seq : snapshot?.seq ?? 0;
  }

  /** Writes the JSON projection. The event log is the source of truth; this file only serves readers that have not migrated. */
  private async save(): Promise<void> {
    const contents = JSON.stringify(this.state, null, 2);
    await mkdir(resolve(this.file, ".."), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents);
    await rename(temporary, this.file);
    if (this.seq % SNAPSHOT_INTERVAL === 0) await writeSnapshot(this.logDir, this.seq, JSON.parse(contents) as TaskState);
  }
}
