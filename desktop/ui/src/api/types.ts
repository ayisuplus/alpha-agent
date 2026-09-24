export type TaskStatus = "active" | "stopped" | "complete" | "needs-input";
export type ControlHolder = "alpha" | "user";
export type GuidanceStatus = "recorded" | "delivered" | "processed";
export interface TaskMeta { title?: string; pinned?: boolean; archived?: boolean }

export interface TaskSummary {
  id: string;
  taskType?: "web-product" | "code-change" | "research" | "file-work";
  workspaceOrigin?: { kind: "generated" | "git" | "copy"; sourcePath?: string; initialRevision?: string };
  objective: string;
  originalObjective?: string;
  contractVersion: number;
  status: TaskStatus;
  running: boolean;
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
  status: "pending" | "approved" | "denied" | "running" | "complete" | "uncertain";
  createdAt: string;
  result?: { exitCode: number; logPath: string; revision: string };
}
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
  contractVersion?: number;
  toolCalls: number;
  elapsedMs: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input";
  failureReason?: string;
  recordedAt: string;
}

export interface TaskView extends TaskSummary {
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
  latestRun: RunRecord | null;
  evidence: EvidenceItem[];
  inputs?: Array<{ id: string; name: string; mimeType: string; sha256: string; uploadedAt: string; url: string }>;
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
  kind: "run" | "publish" | "verify" | "cleanup" | "apply";
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
  budget: { maxToolCalls: number; wallTimeMinutes: number; maxTotalToolCalls: number; totalWallTimeMinutes: number };
  generation: { comfyUrl: string; image: boolean; voice: boolean; video: boolean };
  plugins: { comfyui: boolean };
  notifications: { enabled: boolean };
  ui: { scale: number; fontSize: FontSize; sidebarCollapsed: boolean; previewCollapsed: boolean; previewRatio: number };
}

export interface SkillPlugin {
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
      openFolder?(path: string): Promise<string>;
      openExternal?(url: string): Promise<boolean>;
      saveText?(filename: string, content: string): Promise<boolean>;
      notify?(title: string, body: string, taskId: string): void;
      attention?(): void;
      onOpenTask?(callback: (taskId: string) => void): () => void;
    };
  }
}
