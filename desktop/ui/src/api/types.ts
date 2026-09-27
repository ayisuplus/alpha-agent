export type TaskStatus = "active" | "stopped" | "complete" | "needs-input";
export type ControlHolder = "alpha" | "user";
export type PermissionMode = "ask" | "auto" | "full";
export interface ProjectRecord { id: string; name: string; version: number; mounts: Array<{ id: string; path: string }>; permissionMode?: PermissionMode; createdAt: string; updatedAt: string }
export type GuidanceStatus = "recorded" | "delivered" | "processed";
export interface TaskMeta { title?: string; pinned?: boolean; archived?: boolean }

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
  goal?: { enabled: boolean; budget?: { maxToolCalls: number; wallTimeMs: number; maxTotalToolCalls: number; totalWallTimeMs: number }; noProgressRuns?: number; stopReason?: string };
  running: boolean;
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
    steps: Array<{ id: string; objective: string; mode: "investigate" | "implement" | "review"; dependsOn: string[]; expertId?: string; skillIds: string[]; status: string; statusReason?: string }>;
    gaps: Array<{ kind: string; description: string; resolvedAt?: string; resolution?: string; blockingReason?: string }>;
    amendments: Array<{ revision: number; reason: string; recordedAt: string }>;
    agents?: Array<{ id: string; expert?: { id: string; name: string; hash: string }; skillIds: string[]; mode: string; orderId: string; lastAttemptId: string; status: string; cognition?: { revision: number; understanding: string; findings: Array<{ text: string; evidence: string[] }>; openQuestions: string[]; nextActions: string[]; sourceRevision: string | null } }>;
    instances?: Array<{ id: string; agentId?: string; parentId?: string; orderId: string; mode: string; order?: { modelSelector?: string }; expert?: { id: string; name: string; hash: string }; skills: Array<{ id: string; hash: string; revision: string }>; status: string; integration?: string; worktreePath?: string; startedAt?: string; endedAt?: string; findings?: string[] }>;
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
  blockedService?: string | null;
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

export type ActivityKind = "status" | "tool" | "text" | "error" | "guidance";

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

export interface TaskList {
  tasks: TaskSummary[];
  activeTaskId: string | null;
  activeRunId: string | null;
  operation: OperationSnapshot | null;
}

export interface OperationSnapshot {
  id: string;
  kind: "run" | "publish" | "verify" | "cleanup" | "apply" | "sandbox-check";
  taskId: string | null;
  phase: string;
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
  model: { default: string | null; translation: string | null };
  workerModels: { investigate: string | null; implement: string | null; review: string | null };
  budget: { maxToolCalls: number; wallTimeMinutes: number; maxTotalToolCalls: number; totalWallTimeMinutes: number };
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

export interface AgentPresetSummary {
  id: string;
  name: string;
  description: string;
  hash: string;
  enabled: boolean;
  builtin: boolean;
  basedOn?: string;
  skillIds?: string[];
  package?: { revision: string; skills: Array<{ id: string; hash: string }> };
  source?: { url: string; revision: string; path: string };
}

export interface AgentPreset extends AgentPresetSummary {
  instructions: string;
}

export type SettingsPatch = { [K in keyof Omit<Settings, "version" | "revision">]?: Partial<Settings[K]> };

export type ServerMessage =
  | { type: "operation"; operation: OperationSnapshot | null }
  | { type: "settings"; settings: Settings }
  | { type: "status"; taskId?: string; phase: string; runId?: string; pending?: string[] }
  | { type: "text"; taskId?: string; value: string }
  | { type: "tool"; taskId?: string; name: string; state: string; error?: boolean }
  | { type: "preview"; taskId?: string; url: string; previewId: string; pending: string[] }
  | { type: "task"; taskId?: string; task: TaskView }
  | { type: "activity"; taskId: string; entry: ActivityEntry }
  | { type: "control"; holder: ControlHolder }
  | { type: "error"; taskId?: string; message: string };

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
