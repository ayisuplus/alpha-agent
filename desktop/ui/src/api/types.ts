export type TaskStatus = "active" | "stopped" | "complete";
export type ControlHolder = "alpha" | "user";
export type GuidanceStatus = "recorded" | "delivered" | "processed";

export interface TaskSummary {
  id: string;
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
}

export interface Criterion {
  id: string;
  description: string;
  kind?: string;
}

export interface EvidenceItem {
  id: string;
  criterionId: string;
  kind?: string;
  passed: boolean;
  source: string;
  recordedAt: string;
  contractVersion: number;
  revision: string;
  previewId: string | null;
  current: boolean;
}

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
  outcome: "returned" | "cancelled" | "budget" | "error";
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
  latestRun: RunRecord | null;
  evidence: EvidenceItem[];
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
}

export interface TaskList {
  tasks: TaskSummary[];
  activeTaskId: string | null;
  activeRunId: string | null;
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

export type FontSize = "sm" | "md" | "lg";

export interface Settings {
  version: 1;
  model: { default: string | null };
  budget: { maxToolCalls: number; wallTimeMinutes: number };
  generation: { comfyUrl: string; image: boolean; voice: boolean; video: boolean };
  notifications: { enabled: boolean };
  ui: { scale: number; fontSize: FontSize; sidebarCollapsed: boolean; previewCollapsed: boolean; previewRatio: number };
}

export type SettingsPatch = { [K in keyof Omit<Settings, "version">]?: Partial<Settings[K]> };

export type ServerMessage =
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
    };
  }
}
