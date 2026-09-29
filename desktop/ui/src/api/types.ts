export type TaskStatus = "active" | "stopped" | "complete" | "needs-input";
export type ControlHolder = "alpha" | "user";
export type PermissionMode = "ask" | "auto" | "full";

// Pause/stop codes owned by src/runtime/pause-reasons.ts; the UI never imports from src/, so the unions are mirrored here.
export type PauseReasonCode = "approval" | "question" | "worker-no-result" | "sandbox" | "model" | "project-state" | "capability" | "budget";
export type PauseAction =
  | "approve" | "deny"
  | "answer"
  | "redispatch" | "review-directly" | "ignore-worker"
  | "view-diagnostics" | "change-permission-mode"
  | "change-model"
  | "recheck-project"
  | "install-capability" | "skip-capability"
  | "add-budget";
export type StopReasonCode = "user" | "model" | "sandbox" | "budget" | "error" | "no-progress" | "reconciled";

export interface ProjectRecord { id: string; name: string; version: number; mounts: Array<{ id: string; path: string }>; permissionMode?: PermissionMode; createdAt: string; updatedAt: string }
export type AutomationSchedule = { kind: "once"; at: string } | { kind: "rrule"; rule: string; timeZone: string; startAt: string };
export interface Automation { id: string; name: string; prompt: string; kind: "cron" | "heartbeat"; status: "ACTIVE" | "PAUSED"; schedule: AutomationSchedule; nextRunAt: string | null; modelSelector: string | null; executor?: "scoped-git-backup"; notificationPolicy: "all" | "failures"; projectId?: string; mountId?: string; targetTaskId?: string; createdAt: string; updatedAt: string }
export interface AutomationRun { id: string; automationId: string; dueAt: string; status: "pending" | "running" | "complete" | "failed" | "needs-input" | "skipped"; missedCount: number; taskId?: string; result?: string; startedAt?: string; finishedAt?: string; readAt?: string }
export type GuidanceStatus = "recorded" | "delivered" | "processed";
export interface TaskMeta { title?: string; autoTitle?: string; pinned?: boolean; archived?: boolean }

export interface TaskSummary {
  id: string;
  projectId?: string | null;
  projectVersion?: number | null;
  permissionMode?: PermissionMode | null;
  taskType?: "web-product" | "code-change" | "research" | "file-work" | "general";
  workspaceOrigin?: { kind: "generated" | "git" | "copy" | "direct"; sourcePath?: string; initialRevision?: string };
  objective: string;
  designatedExpertId?: string | null;
  originalObjective?: string;
  contractVersion: number;
  status: TaskStatus;
  phase?: "plan" | "plan-review" | "execute";
  goal?: { enabled: boolean; revision?: number; budget?: { maxToolCalls: number; wallTimeMs: number; maxTotalToolCalls: number; totalWallTimeMs: number }; noProgressRuns?: number; stopReason?: string };
  running: boolean;
  /** What the task's model run is doing: working on the task, or answering a follow-up question about it. */
  runKind?: RunKind | null;
  queued?: boolean;
  pendingCount: number;
  createdAt?: string;
  updatedAt: string;
  /** The task's own model; null means it follows the workbench default. */
  modelSelector?: string | null;
  meta?: TaskMeta;
}

export interface Criterion {
  id: string;
  description: string;
  kind?: string;
}

export interface EvidenceItem {
  id: string;
  attemptId?: string | null;
  criterionId: string;
  kind?: string;
  passed: boolean;
  source: string;
  recordedAt: string;
  contractVersion: number;
  revision: string;
  previewId: string | null;
  current: boolean;
  contentHash?: string;
  referenceIds?: string[];
}

export interface CommandApproval {
  id: string;
  taskId: string;
  argv: string[];
  purpose: "check" | "other";
  cwd: string;
  network?: boolean;
  scriptCommand?: string;
  status: "pending" | "approved" | "denied" | "running" | "complete" | "uncertain";
  createdAt: string;
  reason?: string;
  risk?: "normal" | "high";
  review?: { reviewer: "user" | "independent-agent" | "policy"; decision: "approved" | "denied" | "escalated"; reason: string; at: string };
  exactAction?: { tool: string; targets: string[]; arguments: Record<string, unknown>; digest: string };
  result?: { exitCode: number; logPath: string; revision: string };
}
export interface WebApproval {
  id: string;
  taskId: string;
  kind: "read" | "write";
  scope: string;
  actionId?: string;
  details?: string;
  status: "pending" | "granted" | "approved" | "denied" | "running" | "complete" | "uncertain";
  requestedAt: string;
  decidedAt?: string;
}
export interface WebTab { tabId: string; targetId: string; url: string; title: string }
export interface WebSource { id: string; url: string; title: string; visitedAt: string; sha256: string; rawSha256: string; kind?: string; provider?: string; text: string }
export interface WebJob { id: string; url: string; status: string; cancelRequested: boolean; creditsUsed?: number; pages?: number }
export interface QueueItem { id: string; taskId: string; instruction: string; status: "pending" | "running" | "complete" | "failed"; createdAt: string; scheduledFor?: string; missedCount?: number; result?: string }
export interface LocalSchedule { id: string; taskId: string; instruction: string; intervalMinutes: number | null; nextRunAt: string; active: boolean; createdAt: string }

export interface GuidanceRecord {
  id?: string;
  instruction: string;
  status?: GuidanceStatus;
  recordedAt: string;
}

export interface RunRecord {
  model: string;
  instanceId?: string;
  contractVersion?: number;
  toolCalls: number;
  elapsedMs: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  prompt?: { systemTokens: number; toolTokens: number; tools: number; contextShare: number | null; exact: boolean };
  outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input";
  failureReason?: string;
  recordedAt: string;
}

export interface TaskView extends TaskSummary {
  planApproval?: { contractVersion: number; cognitionRevision: number; sourceRevision: string; approvedAt: string } | null;
  cognition?: {
    revision: number;
    recipeVersion: number;
    summary: string;
    scope?: string[];
    constraints?: string[];
    openQuestions?: string[];
    candidates: string[];
    taskSkillIds?: string[];
    /** The runtime-owned three-stage skeleton (§3.2); nodes fill it. */
    stages?: Array<"investigate" | "execute" | "review">;
    nodes: Array<{
      id: string;
      objective: string;
      kind: "investigate" | "execute" | "review";
      phase: "investigate" | "execute" | "review";
      dependsOn: string[];
      expertDecision: { expertId?: string; temporaryExpert?: { name: string; description: string; instructions: string; skillIds: string[] }; reason: string };
      host: "coordinator" | "worker";
      consumes?: string[];
      produces?: string[];
      ownedPaths?: string[];
      gateRole?: string;
      skillIds: string[];
      status: "planned" | "ready" | "active" | "waiting" | "done" | "reopened" | "cancelled";
      statusReason?: string;
      revision?: number;
      claimedBy?: string;
      activation?: { host: "coordinator" | "worker"; runId: string; access: "read-only" | "write"; expert?: { id: string; name: string; hash: string }; expertSnapshot?: { id: string; name: string }; temporaryExpert?: { name: string } };
      handoff?: { nodeId: string; runId: string; expert?: { id: string; hash: string }; artifacts: Array<{ path: string; hash: string; kind: string }>; findings?: Array<{ claim: string; source: string }>; verdict?: "pass" | "changes-requested" | "inconclusive"; note: string; unresolved: string[]; contractVersion: number };
    }>;
    gaps: Array<{ kind: string; description: string; resolvedAt?: string; resolution?: string; blockingReason?: string }>;
    amendments: Array<{ revision: number; reason: string; affectedNodes?: string[]; affectedSteps?: string[]; recordedAt: string }>;
    agents?: Array<{ id: string; expert?: { id: string; name: string; hash: string }; skillIds: string[]; kind: string; orderId: string; lastAttemptId: string; status: string; cognition?: { revision: number; understanding: string; findings: Array<{ text: string; evidence: string[] }>; openQuestions: string[]; nextActions: string[]; sourceRevision: string | null } }>;
    instances?: Array<{ id: string; agentId?: string; parentId?: string; orderId: string; kind: string; order?: { modelSelector?: string }; expert?: { id: string; name: string; hash: string }; skills: Array<{ id: string; hash: string; revision: string }>; status: string; integration?: string; worktreePath?: string; startedAt?: string; endedAt?: string; findings?: string[] }>;
    skillSearches?: Array<{ key: string; gapDescription: string; query: string; resultCount: number; error?: string }>;
    skillProposals?: Array<{ id: string; key: string; name: string; description: string; source: string; revision: string; path: string; installs: number; requirements?: { tools: string[]; services: string[]; conflicts: string[] }; status: "pending" | "rejected" | "installed"; installedSkillId?: string }>;
  } | null;
  development?: { enabled: true; review?: { verdict: "pass" | "changes-requested" | "inconclusive"; findings: string[]; evidence?: Array<{ path: string; excerpt: string }>; revision: string; contractVersion: number }; repairAttempts: number } | null;
  revision: string | null;
  projectRoot?: string;
  acceptsGuidance: boolean;
  pending: string[];
  criteria: Criterion[];
  contractHistory?: Array<{ version: number; objective: string; revisedAt: string }>;
  guidanceHistory: GuidanceRecord[];
  runs?: RunRecord[];
  lastFailure: string | null;
  reopenReason: string | null;
  pendingQuestion?: string | null;
  /** Why a needs-input task is waiting, and the resume actions the runtime offers for that code. */
  pauseReason?: PauseReasonCode | null;
  pauseActions?: PauseAction[];
  /** Why a stopped task stopped. */
  stop?: { reason: StopReasonCode; detail?: string; stoppedAt: string } | null;
  checkpoint?: { runId: string; codeCommits: Array<{ root: string; commit: string }>; memoryCommit: string; recordedAt: string } | null;
  checkpointError?: string | null;
  checkpointStatus?: "pending" | "committed" | "failed" | null;
  latestRun: RunRecord | null;
  evidence: EvidenceItem[];
  inputs?: Array<{ id: string; name: string; mimeType: string; size?: number | null; sha256: string; uploadedAt: string; url: string }>;
  capabilities?: { plugins: Array<{ id: string; revision: string }>; skills: Array<{ id: string; hash: string; revision: string }> } | null;
  screenshotUrl: string | null;
  preview: { id: string; url: string; live: boolean } | null;
}

export type ActivityKind = "status" | "tool" | "text" | "error" | "guidance" | "question";

export interface ActivityEntry {
  id: string;
  taskId?: string;
  operationId: string | null;
  kind: ActivityKind;
  value: string;
  recordedAt: string;
  contractVersion: number;
  revision: string | null;
  previewId: string | null;
  callId?: string;
  target?: string;
  intent?: string;
  error?: boolean;
}

// The durable timeline track, owned by src/runtime/task-event-summary.ts; the UI never imports from src/, so the projection is mirrored here.
export type TaskEventActor = "user" | "runtime" | "coordinator" | "reviewer" | `worker:${string}`;

export interface TaskTimelineEvent {
  seq: number;
  at: string;
  /** e.g. "status/changed", "evidence/recorded", "plan/approved", "worker/updated". */
  type: string;
  /** The run that caused it; null for workbench actions and imports. */
  runId: string | null;
  actor: TaskEventActor;
  /** Chinese, ready to render. */
  label: string;
  detail?: string;
  tone?: "info" | "success" | "warning" | "danger";
  /** Structured references for joins, so the UI never parses a label. */
  refs?: { criterionId?: string; evidenceId?: string; passed?: boolean; verdict?: string; stepId?: string; workerId?: string; orderId?: string; pauseReason?: PauseReasonCode; stopReason?: StopReasonCode };
}

export interface ReviewSummary {
  operationId: string;
  contractVersion: number;
  revision: string | null;
  recordedAt: string;
  paths: string[];
}

export interface SourceChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface ReviewDetail {
  operationId: string;
  contractVersion: number;
  revision: string | null;
  recordedAt: string;
  changes: SourceChange[];
}

export interface EvidenceDetail {
  content: string;
  screenshotUrl: string | null;
  artifactUrl?: string;
}

export type RunKind = "run" | "answer";

/** A model run in progress; several tasks can run side by side up to the configured limit. */
export interface RunInfo {
  runId: string;
  taskId: string | null;
  kind: RunKind;
}

export interface TaskList {
  tasks: TaskSummary[];
  runs: RunInfo[];
  operations: OperationSnapshot[];
}

export interface OperationSnapshot {
  id: string;
  kind: "run" | "answer" | "publish" | "verify" | "cleanup" | "apply" | "sandbox-check" | "mount";
  taskId: string | null;
  projectId: string | null;
  phase: string;
  /** The task whose page the one visible preview browser is showing for this operation. */
  browserTaskId: string | null;
  cancellable: boolean;
}

export interface ModelInfo {
  selector: string;
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  reasoning: boolean;
  tools: boolean;
  images: boolean;
  available: boolean;
}

export interface ProviderInfo {
  id: string;
  origin: "api_key" | "oauth" | "env" | "config" | "runtime" | "fallback" | null;
  envVar?: string;
  storedKey: boolean;
  allowed: boolean;
  models: number;
  available: number;
}

export interface ModelCatalog {
  models: ModelInfo[];
  providers: ProviderInfo[];
  default: string | null;
  builtin: string;
}

export type PromptCategory = "software" | "research" | "creative" | "writing" | "general";
export interface PromptRefinement {
  category: PromptCategory;
  optimized: string;
  english: string;
  changes: string[];
  unresolved: string[];
  warnings: string[];
  usedOriginal: boolean;
  optimizationModel: string;
  translationModel: string;
}

export interface Diagnostics {
  paths: { workspace: string; data: string; products: string };
  versions: { bun: string; omp: string; electron: string | null };
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
}

export interface StorageReport {
  categories: Array<{ id: string; label: string; path: string; bytes: number }>;
  cleanup: { count: number; bytes: number };
}

export type FontSize = "sm" | "md" | "lg";

export interface Settings {
  version: 1;
  revision?: number;
  model: { default: string | null; translation: string | null; providers: string[] };
  workerModels: { investigate: string | null; implement: string | null; review: string | null };
  budget: { maxToolCalls: number; wallTimeMinutes: number; maxTotalToolCalls: number; totalWallTimeMinutes: number; maxParallelTasks: number };
  generation: { comfyUrl: string; image: boolean; voice: boolean; video: boolean };
  plugins: { comfyui: boolean };
  notifications: { enabled: boolean };
  ui: { scale: number; fontSize: FontSize; sidebarCollapsed: boolean; previewCollapsed: boolean; previewRatio: number };
}

export interface SkillPlugin {
  internalized?: boolean;
  id: string;
  name: string;
  source: string;
  revision: string;
  enabled: boolean;
  skillCount: number;
  hookCount: number;
  hooksEnabled: boolean;
  mcpCount: number;
  mcpEnabled: boolean;
}

export type ExpertLine = "development" | "research" | "content" | "game" | "office" | "general";

export interface ExpertSummary {
  id: string;
  name: string;
  description: string;
  hash: string;
  enabled: boolean;
  builtin: boolean;
  line?: ExpertLine;
  basedOn?: string;
  skillIds?: string[];
  package?: { revision: string; skills: Array<{ id: string; hash: string }> };
  source?: { url: string; revision: string; path: string };
}

export interface Expert extends ExpertSummary {
  instructions: string;
}

export type SettingsPatch = { [K in keyof Omit<Settings, "version" | "revision">]?: Partial<Settings[K]> };

export type ServerMessage =
  | { type: "operations"; operations: OperationSnapshot[] }
  | { type: "runs"; runs: RunInfo[] }
  | { type: "settings"; settings: Settings }
  | { type: "status"; taskId?: string; phase: string; runId?: string; pending?: string[] }
  | { type: "text"; taskId?: string; value: string }
  | { type: "tool"; taskId?: string; name: string; state: string; error?: boolean }
  | { type: "preview"; taskId?: string; url: string; previewId: string; pending: string[] }
  | { type: "task"; taskId?: string; task: TaskView }
  | { type: "activity"; taskId: string; entry: ActivityEntry }
  | { type: "control"; holder: ControlHolder }
  | { type: "error"; taskId?: string; message: string; runId?: string };

export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

declare global {
  interface Window {
    alpha?: {
      loadPreview(url: string): void;
      clearPreview(): void;
      setPreviewBounds?(rect: PreviewRect): void;
      setWebBounds?(tabId: string | null, rect: PreviewRect): void;
      onWebTabRequested?(callback: (request: { taskId: string; tabId: string }) => void): () => void;
      onWebTabClosed?(callback: (tabId: string) => void): () => void;
      openFolder?(path: string): Promise<string>;
      openExternal?(url: string): Promise<boolean>;
      saveText?(filename: string, content: string): Promise<boolean>;
      notify?(title: string, body: string, taskId: string): void;
      attention?(): void;
      onOpenTask?(callback: (taskId: string) => void): () => void;
    };
  }
}
