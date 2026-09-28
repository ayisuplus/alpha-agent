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
import type { TaskActor, TaskEvent, TaskEventPayloads, TaskEventPlan, WorkerStopReason } from "./task-events";
import type { PauseReasonCode, StopReasonCode } from "./pause-reasons";
import type { AgentMessage } from "./agent-mailbox";

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
  instanceId?: string;
  thinkingPolicyVersion?: number;
  contractVersion?: number;
  toolCalls: number;
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
  outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input";
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

export type ExecutionMode = "investigate" | "implement" | "review";
export interface AgentRecord {
  id: string;
  expert?: import("./agent-presets").AgentPresetSnapshot;
  skillIds: string[];
  skillSnapshots?: NonNullable<import("./work-orders").WorkOrder["skillSnapshots"]>;
  capabilityIds?: string[];
  capabilitySnapshots?: NonNullable<import("./work-orders").WorkOrder["capabilitySnapshots"]>;
  contextRevision?: number;
  mode: ExecutionMode;
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
export interface CognitionStep {
  id: string;
  objective: string;
  mode: ExecutionMode;
  dependsOn: string[];
  expertId?: string;
  skillIds: string[];
  status: "planned" | "running" | "complete" | "blocked" | "cancelled";
  statusReason?: string;
  /** Board revision of this step; every transition bumps it and callers pass the value they read (compare-and-swap). */
  revision?: number;
  /** The subagent attempt that claimed the step, when one did. */
  claimedBy?: string;
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
  steps: CognitionStep[];
  gaps: Array<{ kind: "method" | "tool" | "permission" | "context"; description: string; recordedAt: string; resolvedAt?: string; resolution?: string; blockingReason?: string }>;
  amendments: Array<{ revision: number; reason: string; affectedSteps: string[]; recordedAt: string }>;
  basedOnRevision?: string | null;
  skillSearches?: Array<{ key: string; gapDescription: string; query: string; resultCount: number; error?: string; recordedAt: string }>;
  skillProposals?: Array<{ id: string; key: string; name: string; description: string; source: string; revision: string; path: string; installs: number; requirements?: { tools: string[]; services: string[]; conflicts: string[] }; status: "pending" | "rejected" | "installed"; installedSkillId?: string; recordedAt: string }>;
  agents?: AgentRecord[];
  instances?: Array<{ id: string; agentId?: string; parentId?: string; orderId: string; mode: ExecutionMode; expert?: { id: string; name: string; hash: string }; skills: NonNullable<import("./work-orders").WorkOrder["skillSnapshots"]>; contractVersion: number; cognitionRevision: number; baseRevision: string | null; status: "queued" | "running" | "returned" | "completed" | "blocked" | "failed" | "cancelled"; integration?: "pending" | "merged" | "conflict"; decisionReason?: string; integrationDecision?: { action: "integrate" | "reject"; reason: string; runId: string; contractVersion: number; sourceRevision: string | null; recordedAt: string }; workRoot?: string; worktreePath?: string; order?: import("./work-orders").WorkOrder; stopReason?: WorkerStopReason; pid?: number; activatedAt?: string; startedAt: string; endedAt?: string; findings?: string[] }>;
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
  goal?: { enabled: boolean; budget?: GoalBudget; noProgressRuns?: number; stopReason?: GoalStopReason; revision?: number };
  pendingQuestion?: string;
  /** Why a `needs-input` task waits; the workbench derives its resume buttons from this code (plan §4.4). */
  pauseReason?: PauseReasonCode;
  /** Why a `stopped` task stopped, instead of reading the cause back out of `lastFailure`. */
  stop?: { reason: StopReasonCode; detail?: string; stoppedAt: string };
  revision: string | null;
  evidence: Evidence[];
  runs?: RunRecord[];
  preview: LocalPreview | null;
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
      cognition: { revision: 1, recipeVersion: 1, summary: input.objective.trim(), candidates: [], steps: [], gaps: [], amendments: [] },
      projectRoot,
      criteria: input.criteria,
      status: "active",
      phase: input.startMode ?? "execute",
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
    const event = await appendEvent(taskLogDir(path), {
      at: new Date().toISOString(), actor: "runtime", type: "task/imported",
      payload: { state: JSON.parse(contents) as TaskState, source: "legacy-json" },
    }, 0);
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

  async updateStep(id: string, status: CognitionStep["status"], reason: string): Promise<void> {
    await this.commit(() => {
      const step = this.state.cognition?.steps.find(item => item.id === id);
      // Compare-and-swap on the board revision: a concurrent claim or completion makes this call re-plan.
      return { type: "step/changed", payload: { id, status, reason, expectedRevision: step?.revision ?? 0 } };
    });
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

  async reviseCognition(input: { summary: string; candidates: string[]; steps: CognitionStep[]; reason: string; scope?: string[]; constraints?: string[]; openQuestions?: string[] }): Promise<void> {
    await this.commit(() => ({ type: "plan/revised", payload: { input, recordedAt: new Date().toISOString() } }));
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

  async recordDispatch(input: { id: string; orderId: string; mode: ExecutionMode; expert?: { id: string; name: string; hash: string }; skills: Array<{ id: string; hash: string; revision: string }>; decisionReason?: string }): Promise<void> {
    this.assertActive();
    if (this.state.cognition?.instances?.some(item => item.id === input.id)) return;
    await this.commit(() => ({ type: "worker/dispatched", payload: { ...input, startedAt: new Date().toISOString() } }));
  }

  async queueWorker(input: { id: string; parentId?: string; order: import("./work-orders").WorkOrder; expert?: { id: string; name: string; hash: string } }): Promise<void> {
    const { preset, ...order } = input.order;
    await this.commit(() => ({
      type: "worker/queued",
      payload: { attemptId: input.id, ...(input.parentId ? { parentId: input.parentId } : {}), order, ...(preset ? { preset } : {}), ...(input.expert ? { expert: input.expert } : {}), startedAt: new Date().toISOString() },
    }));
  }

  async updateWorker(id: string, status: "running" | "returned" | "completed" | "blocked" | "failed" | "cancelled", patch: { workRoot?: string; worktreePath?: string; findings?: string[]; integration?: "pending" | "merged" | "conflict"; integrationDecision?: NonNullable<CognitionState["instances"]>[number]["integrationDecision"]; skills?: NonNullable<import("./work-orders").WorkOrder["skillSnapshots"]>; capabilities?: NonNullable<import("./work-orders").WorkOrder["capabilitySnapshots"]>; cognition?: AgentRecord["cognition"] } = {}): Promise<void> {
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

  async recordRun(input: Omit<RunRecord, "recordedAt">): Promise<void> {
    await this.commit(() => ({ type: "run/ended", payload: { run: { ...input, contractVersion: this.state.contractVersion ?? 1, recordedAt: new Date().toISOString() } } }));
  }

  async stop(reason: StopReasonCode, detail?: string): Promise<void> {
    await this.commit(() => ({ type: "status/changed", payload: { status: "stopped", reason, ...(detail ? { detail } : {}) } }));
  }

  async needInput(question: string, reason?: PauseReasonCode): Promise<void> {
    await this.commit(() => ({ type: "status/changed", payload: { status: "needs-input", question, ...(reason ? { reason } : {}) } }));
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
