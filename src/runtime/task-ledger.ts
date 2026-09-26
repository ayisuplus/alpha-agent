import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isAllowedModelSelector } from "./model-policy";
import { excludedSourceDirectory } from "./source-review";

export type EvidenceKind = "build" | "test" | "browser" | "asset" | "preview" | "source" | "artifact";
export type TaskType = "web-product" | "code-change" | "research" | "file-work" | "general";
export type PermissionMode = "ask" | "auto" | "full";
export type TaskPhase = "plan" | "plan-review" | "execute";
export interface GoalBudget { maxToolCalls: number; wallTimeMs: number; maxTotalToolCalls: number; totalWallTimeMs: number }

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
  stage?: "coordinator" | "implementation" | "review" | "worker";
  instanceId?: string;
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
  outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input";
  failureReason?: string;
  recordedAt: string;
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
  expert: import("./agent-presets").AgentPresetSnapshot;
  skillIds: string[];
  skillSnapshots?: Array<{ id: string; hash: string; revision: string }>;
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
  instances?: Array<{ id: string; agentId?: string; parentId?: string; orderId: string; mode: ExecutionMode; expert?: { id: string; name: string; hash: string }; skills: Array<{ id: string; hash: string; revision: string }>; contractVersion: number; cognitionRevision: number; baseRevision: string | null; status: "queued" | "running" | "returned" | "completed" | "blocked" | "failed" | "cancelled"; integration?: "pending" | "merged" | "conflict"; workRoot?: string; worktreePath?: string; order?: import("./work-orders").WorkOrder; startedAt: string; endedAt?: string; findings?: string[] }>;
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
  development?: DevelopmentState;
  workerOutcome?: { status: "completed" | "needs-context" | "blocked" | "failed"; findings: string[]; reviewVerdict?: "pass" | "changes-requested" | "inconclusive"; reviewEvidence?: Array<{ path: string; excerpt: string }>; requests?: Array<{ capability: string; reason: string; details: string }> };
  projectRoot: string;
  criteria: AcceptanceCriterion[];
  status: "active" | "stopped" | "complete" | "needs-input";
  phase?: TaskPhase;
  planApproval?: { contractVersion: number; cognitionRevision: number; sourceRevision: string; approvedAt: string };
  goal?: { enabled: boolean; budget?: GoalBudget; noProgressRuns?: number; stopReason?: string };
  pendingQuestion?: string;
  blockedService?: string;
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
  private static readonly fileQueues = new Map<string, Promise<void>>();
  private savedHash: string | null = null;
  private legacyBackupPending = false;
  private constructor(readonly file: string, readonly state: TaskState) {}

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
    const ledger = new TaskLedger(file, state);
    await ledger.save();
    return ledger;
  }

  static async load(file: string): Promise<TaskLedger> {
    const contents = await readFile(file, "utf8");
    const state = JSON.parse(contents) as TaskState;
    const ledger = new TaskLedger(resolve(file), state);
    ledger.savedHash = createHash("sha256").update(contents).digest("hex");
    ledger.legacyBackupPending = !state.taskType || !state.contractVersion;
    return ledger;
  }

  async refreshRevision(): Promise<boolean> {
    this.assertActive();
    const revision = await fingerprintSource(this.state.projectRoot);
    if (revision === this.state.revision) return false;
    this.state.revision = revision;
    this.state.preview = null;
    await this.save();
    return true;
  }

  async setCriteria(criteria: AcceptanceCriterion[]): Promise<void> {
    if (this.state.taskType !== "general" || new Set(criteria.map(item => item.id)).size !== criteria.length) throw new Error("Invalid general task criteria");
    this.state.criteria = criteria;
    await this.save();
  }

  async addInputs(inputs: NonNullable<TaskState["inputs"]>): Promise<void> {
    if (this.state.status === "complete") throw new Error("Revise a completed task before adding inputs");
    this.state.inputs = [...(this.state.inputs ?? []), ...inputs];
    await this.save();
  }

  async setCapabilities(capabilities: NonNullable<TaskState["capabilities"]>): Promise<void> {
    if (this.state.status === "complete") throw new Error("Revise a completed task before selecting capabilities");
    this.state.capabilities = capabilities;
    await this.save();
  }

  async confirmProjectVersion(version: number): Promise<void> {
    if (!this.state.projectId || !Number.isInteger(version) || version < 1 || !["needs-input", "stopped"].includes(this.state.status)) throw new Error("Task is not waiting for a project recheck");
    this.state.projectVersion = version;
    this.state.status = "stopped";
    delete this.state.pendingQuestion;
    delete this.state.blockedService;
    this.state.reopenReason = "Project folders rechecked; continue the task when ready";
    await this.save();
  }

  async recordEvidence(input: Omit<Evidence, "id" | "recordedAt">): Promise<Evidence> {
    this.assertActive();
    const criterion = this.state.criteria.find(item => item.id === input.criterionId);
    if (!criterion || criterion.kind !== input.kind) throw new Error("Evidence does not match a criterion");
    if (input.revision !== this.state.revision) throw new Error("Evidence revision is stale");
    if (input.kind === "browser" && (!this.state.preview || input.previewId !== this.state.preview.id)) {
      throw new Error("Browser evidence must match the current preview");
    }
    if (!input.source.trim()) throw new Error("Evidence source is required");
    if ((input.kind === "source" || input.kind === "artifact") && !/^[0-9a-f]{64}$/.test(input.contentHash ?? "")) throw new Error("Versioned source or artifact evidence needs a SHA-256 hash");
    const evidence = { ...input, contractVersion: this.state.contractVersion ?? 1, id: randomUUID(), recordedAt: new Date().toISOString() };
    this.state.evidence.push(evidence);
    await this.save();
    return evidence;
  }

  async recordPreview(input: Omit<LocalPreview, "recordedAt">): Promise<void> {
    this.assertActive();
    if (input.revision !== this.state.revision) throw new Error("Preview revision is stale");
    if (!isAbsolute(input.path) || !input.url.startsWith("http://127.0.0.1:")) {
      throw new Error("Preview must use an absolute local path and loopback URL");
    }
    this.state.preview = { ...input, recordedAt: new Date().toISOString() };
    await this.save();
  }

  completionGaps(): string[] {
    const gaps = this.state.criteria.filter(criterion => {
      const latest = this.state.evidence.findLast(item => item.criterionId === criterion.id && (item.contractVersion ?? 1) === (this.state.contractVersion ?? 1) && item.revision === this.state.revision && (criterion.kind !== "browser" || item.previewId === this.state.preview?.id));
      return !latest?.passed;
    }).map(criterion => criterion.id);
    if ((this.state.taskType ?? "web-product") === "web-product" && (!this.state.preview || this.state.preview.revision !== this.state.revision)) gaps.push("local-preview");
    if (this.state.development?.enabled && (this.state.development.review?.verdict !== "pass" || this.state.development.review.revision !== this.state.revision || this.state.development.review.contractVersion !== (this.state.contractVersion ?? 1))) gaps.push("development-review");
    if (this.state.cognition?.gaps.some(item => !item.resolvedAt)) gaps.push("capability-gap");
    if (this.state.designatedExpertId && !this.state.cognition?.instances?.some(item => item.expert?.id === this.state.designatedExpertId && item.status === "completed" && item.contractVersion === (this.state.contractVersion ?? 1))) gaps.push("designated-expert");
    if (this.state.planApproval && this.state.phase === "execute" && this.state.cognition?.steps.some(step => step.status !== "complete" && step.status !== "cancelled")) gaps.push("plan-steps");
    if (this.state.cognition?.instances?.some(item => item.order && ["queued", "running", "returned"].includes(item.status))) gaps.push("worker-integration");
    return gaps;
  }

  async setGoal(enabled: boolean, budget?: GoalBudget): Promise<void> {
    if (this.state.status === "complete") throw new Error("Completed task cannot change continuation");
    this.state.goal = { ...this.state.goal, enabled, ...(enabled && !this.state.goal?.budget && budget ? { budget } : {}), noProgressRuns: 0, stopReason: enabled ? undefined : "user-disabled" };
    await this.save();
  }

  async setGoalProgress(noProgressRuns: number, stopReason?: string): Promise<void> {
    this.state.goal = { ...this.state.goal, enabled: this.state.goal?.enabled ?? false, noProgressRuns, stopReason };
    await this.save();
  }

  async enterPlan(): Promise<void> {
    if (this.state.status === "complete") throw new Error("Completed task cannot enter planning");
    if (this.state.status === "stopped" || this.state.status === "needs-input") this.state.status = "active";
    delete this.state.pendingQuestion;
    delete this.state.blockedService;
    this.state.phase = "plan";
    delete this.state.planApproval;
    if (this.state.goal) { this.state.goal.stopReason = undefined; this.state.goal.noProgressRuns = 0; }
    await this.save();
  }

  async submitPlanForReview(): Promise<void> {
    if (this.state.phase !== "plan" || !this.state.cognition?.steps.length) throw new Error("A nonempty plan is required for review");
    if (this.state.cognition.basedOnRevision !== this.state.revision) throw new Error("Project changed after planning; review the current source and revise the plan");
    this.state.phase = "plan-review";
    await this.save();
  }

  async approvePlan(expected: { contractVersion: number; cognitionRevision: number; sourceRevision: string }): Promise<void> {
    if (this.state.phase !== "plan-review" || this.state.status !== "active") throw new Error("Task has no plan awaiting review");
    if (expected.contractVersion !== (this.state.contractVersion ?? 1) || expected.cognitionRevision !== this.state.cognition?.revision || expected.sourceRevision !== this.state.revision || await fingerprintSource(this.state.projectRoot) !== this.state.revision) throw new Error("Plan or project changed; review the current version before executing");
    this.state.planApproval = { ...expected, approvedAt: new Date().toISOString() };
    this.state.phase = "execute";
    if (this.state.goal) { this.state.goal.stopReason = undefined; this.state.goal.noProgressRuns = 0; }
    await this.save();
  }

  async updateStep(id: string, status: CognitionStep["status"], reason: string): Promise<void> {
    this.assertActive();
    const step = this.state.cognition?.steps.find(item => item.id === id);
    if (!step || !["running", "complete", "blocked", "cancelled"].includes(status) || !reason.trim()) throw new Error("Step and reason are required");
    if (step.status === "complete" || step.status === "cancelled") throw new Error("Finished step cannot be rewritten");
    if (this.state.cognition?.instances?.some(instance => instance.orderId === id)) throw new Error("Delegated step status is owned by the work order result");
    if (this.state.phase === "plan" && step.mode !== "investigate") throw new Error("Planning can only finish investigation steps");
    if (this.state.phase === "plan-review") throw new Error("Plan is awaiting review");
    if (status === "complete" && step.dependsOn.some(dep => this.state.cognition?.steps.find(item => item.id === dep)?.status !== "complete")) throw new Error("Step dependencies are not complete");
    step.status = status;
    step.statusReason = reason.trim();
    await this.save();
  }

  async enableDevelopmentWorkflow(): Promise<void> {
    if (this.state.development?.enabled) return;
    this.state.development = { enabled: true, repairAttempts: 0 };
    await this.save();
  }

  async setInitialCandidates(ids: string[]): Promise<void> {
    const cognition = this.state.cognition;
    if (!cognition || cognition.revision !== 1 || cognition.candidates.length || (!ids.length && !this.state.designatedExpertId)) return;
    cognition.candidates = [...new Set([...(this.state.designatedExpertId ? [this.state.designatedExpertId] : []), ...ids])].slice(0, 3);
    await this.save();
  }

  async reviseCognition(input: { summary: string; candidates: string[]; steps: CognitionStep[]; reason: string; scope?: string[]; constraints?: string[]; openQuestions?: string[] }): Promise<void> {
    this.assertActive();
    if (!input.summary.trim() || !input.reason.trim() || input.steps.length > 20) throw new Error("认知修订内容无效");
    const ids = new Set(input.steps.map(step => step.id));
    if (ids.size !== input.steps.length || input.steps.some(step => !/^[a-z][a-z0-9-]{0,31}$/.test(step.id) || ["coordinator", "final-review", "review-repair"].includes(step.id) || !step.objective.trim() || step.dependsOn.some(id => !ids.has(id) || id === step.id))) throw new Error("认知步骤无效");
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(input.steps.map(step => [step.id, step]));
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error("认知步骤存在循环依赖");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
    const previous = this.state.cognition ?? { revision: 0, recipeVersion: 1, summary: this.state.objective, candidates: [], steps: [], gaps: [], amendments: [] };
    if (this.state.designatedExpertId && (!input.candidates.includes(this.state.designatedExpertId) || (input.steps.length > 0 && !input.steps.some(step => step.expertId === this.state.designatedExpertId)))) throw new Error(`用户指定专家必须保留在计划中：${this.state.designatedExpertId}`);
    for (const prior of previous.steps.filter(step => step.status === "running" || step.status === "complete")) {
      const next = input.steps.find(step => step.id === prior.id);
      if (!next || next.objective !== prior.objective || next.mode !== prior.mode || next.expertId !== prior.expertId || JSON.stringify(next.dependsOn) !== JSON.stringify(prior.dependsOn) || JSON.stringify(next.skillIds) !== JSON.stringify(prior.skillIds)) throw new Error(`已派发或完成的认知步骤不可改写：${prior.id}`);
    }
    const revision = previous.revision + 1;
    const clean = (values: string[] | undefined, fallback: string[] | undefined) => values === undefined ? fallback : [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 20);
    const nextScope = clean(input.scope, previous.scope);
    const nextConstraints = clean(input.constraints, previous.constraints);
    const stepDefinition = (step: CognitionStep) => JSON.stringify([step.objective, step.mode, step.expertId ?? null, step.dependsOn, step.skillIds]);
    const materialChange = !!this.state.planApproval && (JSON.stringify(nextScope) !== JSON.stringify(previous.scope) || JSON.stringify(nextConstraints) !== JSON.stringify(previous.constraints) || input.steps.some(step => !previous.steps.some(prior => prior.id === step.id)) || previous.steps.some(prior => prior.status !== "complete" && prior.status !== "running" && !input.steps.some(step => step.id === prior.id && stepDefinition(step) === stepDefinition(prior))));
    this.state.cognition = { ...previous, revision, basedOnRevision: this.state.revision, summary: input.summary.trim(), scope: nextScope, constraints: nextConstraints, openQuestions: clean(input.openQuestions, previous.openQuestions), candidates: [...new Set(input.candidates)], steps: input.steps.map(step => ({ ...step, status: previous.steps.find(prior => prior.id === step.id)?.status ?? "planned", statusReason: previous.steps.find(prior => prior.id === step.id)?.statusReason, dependsOn: [...step.dependsOn], skillIds: [...step.skillIds] })), amendments: [...previous.amendments, { revision, reason: input.reason.trim(), affectedSteps: input.steps.map(step => step.id), recordedAt: new Date().toISOString() }] };
    if (materialChange) { this.state.phase = "plan-review"; delete this.state.planApproval; }
    await this.save();
  }

  async recordCapabilityGap(kind: CognitionState["gaps"][number]["kind"], description: string): Promise<void> {
    this.assertActive();
    if (!description.trim()) throw new Error("能力缺口说明不能为空");
    this.state.cognition ??= { revision: 1, recipeVersion: 1, summary: this.state.objective, candidates: [], steps: [], gaps: [], amendments: [] };
    if (this.state.cognition.gaps.some(item => item.kind === kind && item.description === description.trim())) return;
    this.state.cognition.gaps.push({ kind, description: description.trim(), recordedAt: new Date().toISOString() });
    this.state.cognition.revision++;
    await this.save();
  }

  async resolveCapabilityGap(kind: CognitionState["gaps"][number]["kind"], description: string, resolution: string): Promise<void> {
    if (!resolution.trim()) throw new Error("能力缺口解决依据不能为空");
    const gap = this.state.cognition?.gaps.find(item => item.kind === kind && item.description === description && !item.resolvedAt);
    if (!gap) throw new Error("待解决的能力缺口不存在");
    gap.resolvedAt = new Date().toISOString();
    gap.resolution = resolution.trim();
    delete gap.blockingReason;
    this.state.cognition!.revision++;
    await this.save();
  }

  async recordSkillSearch(input: { key: string; gapDescription: string; query: string; error?: string; proposals: Array<{ name: string; description: string; source: string; revision: string; path: string; installs: number; requirements?: { tools: string[]; services: string[]; conflicts: string[] } }> }): Promise<void> {
    this.assertActive();
    const cognition = this.state.cognition!;
    if (cognition.skillSearches?.some(item => item.key === input.key)) return;
    const now = new Date().toISOString();
    (cognition.skillSearches ??= []).push({ key: input.key, gapDescription: input.gapDescription, query: input.query, resultCount: input.proposals.length, ...(input.error ? { error: input.error } : {}), recordedAt: now });
    (cognition.skillProposals ??= []).push(...input.proposals.map(item => ({ ...item, key: input.key, id: randomUUID(), status: "pending" as const, recordedAt: now })));
    cognition.revision++;
    await this.save();
  }

  async decideSkillProposal(id: string, decision: "rejected" | "installed", installedSkillId?: string): Promise<void> {
    this.assertActive();
    const proposal = this.state.cognition?.skillProposals?.find(item => item.id === id);
    if (!proposal || proposal.status !== "pending") throw new Error("Skill 提案不存在或已处理");
    if (decision === "installed" && !installedSkillId) throw new Error("安装后的 Skill ID 缺失");
    proposal.status = decision;
    if (installedSkillId) proposal.installedSkillId = installedSkillId;
    this.state.cognition!.revision++;
    if (decision === "installed") {
      (this.state.cognition!.taskSkillIds ??= []).push(installedSkillId!);
      const search = this.state.cognition!.skillSearches?.find(item => item.key === proposal.key);
      const gap = this.state.cognition!.gaps.find(item => !item.resolvedAt && item.kind === "method" && item.description === search?.gapDescription);
      const workerTools = new Set(["read", "grep", "edit", "write", "alpha_build", "alpha_worker_result"]);
      const blockers = [
        ...(proposal.requirements?.services.map(service => `需要外部服务 ${service}`) ?? []),
        ...(proposal.requirements?.tools.filter(tool => !workerTools.has(tool)).map(tool => `worker 缺少工具 ${tool}`) ?? []),
        ...(proposal.requirements?.conflicts.filter(other => this.state.cognition!.taskSkillIds?.includes(other)).map(other => `与 ${other} 冲突`) ?? []),
      ];
      if (gap && !blockers.length) { gap.resolvedAt = new Date().toISOString(); gap.resolution = `Installed ${installedSkillId}`; delete gap.blockingReason; }
      else if (gap) gap.blockingReason = `已安装 ${installedSkillId}，但${blockers.join("、")}；仍需调整执行方式或能力`;
    }
    await this.save();
  }

  async recordDispatch(input: { id: string; orderId: string; mode: ExecutionMode; expert?: { id: string; name: string; hash: string }; skills: Array<{ id: string; hash: string; revision: string }> }): Promise<void> {
    this.assertActive();
    this.state.cognition ??= { revision: 1, recipeVersion: 1, summary: this.state.objective, candidates: [], steps: [], gaps: [], amendments: [] };
    if (this.state.cognition.instances?.some(item => item.id === input.id)) return;
    (this.state.cognition.instances ??= []).push({ ...input, skills: input.skills.map(item => ({ ...item })), contractVersion: this.state.contractVersion ?? 1, cognitionRevision: this.state.cognition.revision, baseRevision: this.state.revision, status: "running", startedAt: new Date().toISOString() });
    const step = ["coordinator", "final-review", "review-repair"].includes(input.orderId) ? undefined : this.state.cognition.steps.find(item => item.id === input.orderId);
    if (step) { step.status = "running"; step.statusReason = `工单 ${input.id} 运行中`; }
    await this.save();
  }

  async queueWorker(input: { id: string; parentId?: string; order: import("./work-orders").WorkOrder; expert?: { id: string; name: string; hash: string } }): Promise<void> {
    this.assertActive();
    this.state.cognition ??= { revision: 1, recipeVersion: 1, summary: this.state.objective, candidates: [], steps: [], gaps: [], amendments: [] };
    if (this.state.cognition.instances?.some(item => item.id === input.id)) throw new Error("Worker attempt already exists");
    const { preset: _preset, ...order } = input.order;
    if (order.agentId) {
      if (!_preset?.package?.skills.length || !order.skillIds?.length) throw new Error("Subagent requires a versioned expert persona and Skill");
      const agents = this.state.cognition.agents ??= [];
      const existing = agents.find(item => item.id === order.agentId);
      if (existing) {
        if (existing.expert.hash !== _preset.hash || existing.orderId !== order.id || JSON.stringify(existing.skillIds) !== JSON.stringify(order.skillIds)) throw new Error("Subagent identity or expert/skills changed");
        if (["queued", "running"].includes(existing.status)) throw new Error("Subagent is already running");
        const previous = (this.state.cognition.instances ?? []).find(item => item.id === existing.lastAttemptId);
        if (previous?.status === "returned") { previous.status = "cancelled"; previous.findings = [...(previous.findings ?? []), "Superseded by continuation"]; previous.endedAt = new Date().toISOString(); }
        existing.lastAttemptId = input.id;
        existing.mode = order.mode ?? "implement";
        existing.status = "queued";
      } else agents.push({ id: order.agentId, expert: _preset, skillIds: [...order.skillIds], mode: order.mode ?? "implement", orderId: order.id, lastAttemptId: input.id, status: "queued" });
    }
    (this.state.cognition.instances ??= []).push({ id: input.id, agentId: order.agentId, parentId: input.parentId, orderId: order.id, order, mode: order.mode ?? "implement", expert: input.expert, skills: [], contractVersion: this.state.contractVersion ?? 1, cognitionRevision: this.state.cognition.revision, baseRevision: this.state.revision, status: "queued", startedAt: new Date().toISOString() });
    const step = this.state.cognition.steps.find(item => item.id === order.id);
    if (step) { step.status = "running"; step.statusReason = `工单 ${input.id} 排队中`; }
    await this.save();
  }

  async updateWorker(id: string, status: "running" | "returned" | "completed" | "blocked" | "failed" | "cancelled", patch: { workRoot?: string; worktreePath?: string; findings?: string[]; integration?: "pending" | "merged" | "conflict"; skills?: Array<{ id: string; hash: string; revision: string }>; cognition?: AgentRecord["cognition"] } = {}): Promise<void> {
    const instance = this.state.cognition?.instances?.find(item => item.id === id);
    if (!instance || !instance.order) throw new Error("Worker attempt not found");
    if (["completed", "blocked", "failed", "cancelled"].includes(instance.status)) return;
    Object.assign(instance, patch, { status });
    const agent = this.state.cognition?.agents?.find(item => item.id === instance.agentId);
    if (agent && agent.lastAttemptId === id) {
      agent.status = status === "blocked" ? "waiting-primary" : status;
      if (patch.cognition) agent.cognition = patch.cognition;
      if (patch.skills) {
        agent.skillSnapshots = patch.skills.map(item => ({ ...item }));
        if (instance.order) instance.order.skillSnapshots = patch.skills.map(item => ({ ...item }));
      }
    }
    if (status !== "running") instance.endedAt = new Date().toISOString();
    const step = this.state.cognition?.steps.find(item => item.id === instance.orderId);
    if (step) { step.status = status === "completed" ? "complete" : ["blocked", "failed", "cancelled"].includes(status) ? "blocked" : "running"; step.statusReason = `工单 ${id} ${status}${patch.integration ? ` / ${patch.integration}` : ""}`; }
    await this.save();
  }

  async updateWorkerCognition(input: Omit<WorkerCognition, "revision" | "sourceRevision" | "updatedAt">): Promise<WorkerCognition> {
    this.assertActive();
    if (!input.understanding.trim() || input.understanding.length > 2_000 || input.findings.length > 20 || input.openQuestions.length > 20 || input.nextActions.length > 20) throw new Error("Worker cognition is invalid or too large");
    const known = new Set((this.state.workerReceipts ?? []).map(item => item.id));
    if (input.findings.some(item => !item.text.trim() || item.text.length > 500 || item.evidence.some(id => !known.has(id)))) throw new Error("Worker finding cites an unknown evidence receipt");
    this.state.workerCognition = { ...input, revision: (this.state.workerCognition?.revision ?? 0) + 1, sourceRevision: await fingerprintSource(this.state.projectRoot), updatedAt: new Date().toISOString() };
    await this.save();
    return this.state.workerCognition;
  }

  async recordWorkerCheckReceipt(input: { attemptId: string; sourceRevision: string | null; passed: boolean; path: string }): Promise<string> {
    const id = randomUUID();
    (this.state.workerReceipts ??= []).push({ id, ...input, kind: "check", recordedAt: new Date().toISOString() });
    await this.save();
    return id;
  }

  async prepareWorkerRun(): Promise<void> {
    if (this.state.status === "complete") throw new Error("Completed worker state cannot be continued");
    this.state.status = "active";
    delete this.state.pendingQuestion;
    delete this.state.blockedService;
    delete this.state.workerOutcome;
    await this.save();
  }

  async finishDispatch(id: string, status: "completed" | "blocked" | "failed" | "cancelled", findings: string[] = []): Promise<void> {
    const instance = this.state.cognition?.instances?.find(item => item.id === id);
    if (!instance || instance.status !== "running") return;
    instance.status = status;
    instance.findings = findings;
    instance.endedAt = new Date().toISOString();
    const step = ["coordinator", "final-review", "review-repair"].includes(instance.orderId) ? undefined : this.state.cognition?.steps.find(item => item.id === instance.orderId);
    if (step) { step.status = status === "completed" ? "complete" : status === "cancelled" ? "cancelled" : "blocked"; step.statusReason = findings.join("；") || `工单 ${id} ${status}`; }
    await this.save();
  }

  async reconcileRunningInstances(reason: string): Promise<void> {
    const running = this.state.cognition?.instances?.filter(item => item.status === "running" || item.status === "queued") ?? [];
    if (!running.length) return;
    for (const instance of running) {
      instance.status = "failed";
      instance.findings = [reason];
      instance.endedAt = new Date().toISOString();
      const step = this.state.cognition?.steps.find(item => item.id === instance.orderId);
      if (step) step.status = "blocked";
    }
    await this.save();
  }

  async recordDevelopmentReview(input: { verdict: NonNullable<DevelopmentState["review"]>["verdict"]; findings: string[]; evidence?: Array<{ path: string; excerpt: string }>; instanceId: string; expectedRevision?: string; expectedContractVersion?: number }): Promise<void> {
    this.assertActive();
    if (!this.state.development?.enabled || !this.state.revision || !input.instanceId) throw new Error("开发审查状态无效");
    if (input.expectedRevision && (this.state.revision !== input.expectedRevision || await fingerprintSource(this.state.projectRoot) !== input.expectedRevision)) throw new Error("Reviewed source version changed");
    if (input.expectedContractVersion && (this.state.contractVersion ?? 1) !== input.expectedContractVersion) throw new Error("Reviewed task contract changed");
    const { expectedRevision: _revision, expectedContractVersion: _contract, ...review } = input;
    this.state.development.review = { ...review, findings: input.findings.map(item => item.trim()).filter(Boolean), revision: this.state.revision, contractVersion: this.state.contractVersion ?? 1, recordedAt: new Date().toISOString() };
    await this.save();
  }

  async recordRepairAttempt(): Promise<void> {
    if (!this.state.development?.enabled || this.state.development.repairAttempts >= 2) throw new Error("自动修复次数已用尽");
    this.state.development.repairAttempts++;
    await this.save();
  }

  async recordWorkerOutcome(input: NonNullable<TaskState["workerOutcome"]>): Promise<void> {
    this.assertActive();
    this.state.workerOutcome = { ...input, requests: input.requests ?? this.state.workerOutcome?.requests, findings: input.findings.map(item => item.trim()).filter(Boolean) };
    await this.save();
  }

  async complete(): Promise<void> {
    this.assertActive();
    if (this.state.phase !== "execute" && this.state.phase !== undefined) throw new Error("Task plan is not approved for execution");
    if (await fingerprintSource(this.state.projectRoot) !== this.state.revision) throw new Error("Task source changed before completion");
    const gaps = this.completionGaps();
    if (gaps.length > 0) throw new Error(`Task cannot complete: ${gaps.join(", ")}`);
    this.state.status = "complete";
    this.state.lastFailure = undefined;
    this.state.reopenReason = undefined;
    await this.save();
  }

  async reopen(reason: string): Promise<void> {
    if (this.state.status !== "complete") throw new Error("Only a completed task can be reopened");
    if (!reason.trim()) throw new Error("Reopen reason is required");
    this.state.status = "active";
    this.state.reopenReason = reason.trim();
    await this.save();
  }

  async reviseObjective(objective: string): Promise<void> {
    const next = objective.trim();
    if (!next || next === this.state.objective) throw new Error("A changed task objective is required");
    const version = this.state.contractVersion ?? 1;
    this.state.contractHistory ??= [];
    this.state.contractHistory.push({ version, objective: this.state.objective, revisedAt: new Date().toISOString() });
    this.state.objective = next;
    this.state.contractVersion = version + 1;
    if (this.state.planApproval || this.state.phase === "plan-review" || this.state.phase === "plan") { this.state.phase = "plan"; delete this.state.planApproval; }
    this.state.preview = null;
    this.state.status = "active";
    this.state.reopenReason = "User revised the task objective";
    this.state.lastFailure = undefined;
    if (this.state.goal) { this.state.goal.stopReason = undefined; this.state.goal.noProgressRuns = 0; }
    await this.save();
  }

  async resume(reason: string): Promise<void> {
    if (this.state.status !== "stopped" && this.state.status !== "needs-input") throw new Error("Only a stopped or waiting task can be resumed");
    if (!reason.trim()) throw new Error("Resume reason is required");
    this.state.status = "active";
    delete this.state.pendingQuestion;
    delete this.state.blockedService;
    this.state.reopenReason = reason.trim();
    if (this.state.goal) { this.state.goal.stopReason = undefined; this.state.goal.noProgressRuns = 0; }
    this.state.guidanceHistory ??= [];
    this.state.guidanceHistory.push({ instruction: reason.trim(), recordedAt: new Date().toISOString() });
    await this.save();
  }

  async recordGuidance(instruction: string): Promise<string> {
    if (this.state.status === "complete") throw new Error("A completed task cannot receive guidance");
    if (!instruction.trim()) throw new Error("Guidance is required");
    this.state.guidanceHistory ??= [];
    const id = randomUUID();
    this.state.guidanceHistory.push({ id, instruction: instruction.trim(), recordedAt: new Date().toISOString(), status: "recorded" });
    await this.save();
    return id;
  }

  async recordCheckpointStart(): Promise<void> {
    this.state.checkpointStatus = "pending";
    delete this.state.checkpointError;
    await this.save();
  }

  async recordCheckpoint(checkpoint: NonNullable<TaskState["checkpoint"]>): Promise<void> {
    if (this.state.checkpoint?.runId === checkpoint.runId && this.state.checkpoint.memoryCommit === checkpoint.memoryCommit && this.state.checkpointStatus === "committed") return;
    this.state.checkpoint = checkpoint;
    this.state.checkpointStatus = "committed";
    delete this.state.checkpointError;
    await this.save();
  }

  async recordCheckpointFailure(reason: string): Promise<void> {
    this.state.checkpointError = reason;
    this.state.checkpointStatus = "failed";
    await this.save();
  }

  async setGuidanceStatus(id: string, status: "delivered" | "processed"): Promise<void> {
    const guidance = this.state.guidanceHistory?.find(item => item.id === id);
    if (!guidance) throw new Error("Guidance not found");
    if (guidance.status === "processed" || guidance.status === status) return;
    guidance.status = status;
    await this.save();
  }

  async setModel(selector: string | null): Promise<void> {
    if (selector && !isAllowedModelSelector(selector)) throw new Error(`Model is not supported: ${selector}`);
    if (selector) this.state.modelSelector = selector;
    else delete this.state.modelSelector;
    await this.save();
  }

  async recordFailure(reason: string): Promise<void> {
    this.assertActive();
    if (!reason.trim()) throw new Error("Failure reason is required");
    this.state.lastFailure = reason.trim();
    await this.save();
  }

  async clearFailure(): Promise<void> {
    if (!this.state.lastFailure) return;
    this.state.lastFailure = undefined;
    await this.save();
  }

  async recordRun(input: Omit<RunRecord, "recordedAt">): Promise<void> {
    this.state.runs ??= [];
    this.state.runs.push({ ...input, contractVersion: this.state.contractVersion ?? 1, recordedAt: new Date().toISOString() });
    await this.save();
  }

  async stop(): Promise<void> {
    this.assertActive();
    this.state.status = "stopped";
    await this.save();
  }

  async needInput(question: string, service?: string): Promise<void> {
    this.assertActive();
    if (!question.trim()) throw new Error("A user question is required");
    this.state.status = "needs-input";
    this.state.pendingQuestion = question.trim();
    if (service) this.state.blockedService = service;
    await this.save();
  }

  private assertActive(): void {
    if (this.state.status !== "active") throw new Error(`Task is ${this.state.status}`);
  }

  private async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const contents = JSON.stringify(this.state, null, 2);
    const prior = TaskLedger.fileQueues.get(this.file) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(async () => {
      await mkdir(resolve(this.file, ".."), { recursive: true });
      const current = await readFile(this.file, "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const currentHash = current === null ? null : createHash("sha256").update(current).digest("hex");
      if (currentHash !== this.savedHash) throw new Error("Task ledger changed in another operation; reload before updating");
      if (this.legacyBackupPending) {
        try { await copyFile(this.file, `${this.file}.pre-contract-extension.bak`, constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        this.legacyBackupPending = false;
      }
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents);
      await rename(temporary, this.file);
      this.savedHash = createHash("sha256").update(contents).digest("hex");
    });
    TaskLedger.fileQueues.set(this.file, work);
    void work.then(() => { if (TaskLedger.fileQueues.get(this.file) === work) TaskLedger.fileQueues.delete(this.file); }, () => { if (TaskLedger.fileQueues.get(this.file) === work) TaskLedger.fileQueues.delete(this.file); });
    await work;
  }
}
