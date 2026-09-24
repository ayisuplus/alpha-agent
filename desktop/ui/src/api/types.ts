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

export type ServerMessage =
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
