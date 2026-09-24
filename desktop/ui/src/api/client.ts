import type { ActivityEntry, ControlHolder, EvidenceDetail, ReviewDetail, ReviewSummary, TaskList, TaskView } from "./types";

const SERVER_MESSAGES: Record<string, string> = {
  "A task is already running": "已有任务或操作正在进行，请等它结束",
  "Wait for the current operation to finish before saving guidance": "请等当前操作结束后再保存要求",
  "Revise a completed task before adding guidance": "任务已验收，请通过修订目标继续",
  "Task is already complete": "任务已验收，请通过修订目标继续",
  "A changed task objective is required": "新目标与当前目标相同",
  "Brief is required": "请先描述要构建的内容",
  "Guidance is required": "补充要求不能为空",
  "Task not found": "找不到这个任务",
  "Task is not running": "任务已经不在运行",
  "Task is outside products": "任务目录不在当前工作区的 products 内",
  "Task is stopped": "任务已停止，请先继续修复",
  "Build failed": "构建失败",
  "A live active preview is required": "需要一个在线的本机预览",
  "User controls the visible browser": "你正在操作预览，请先交回 Alpha",
  "Another browser verification is running": "另一个浏览器验收正在进行",
  "Evidence unavailable": "证据文件不可用",
  "Review not found": "找不到这轮源码快照",
};

export function describeError(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  return SERVER_MESSAGES[raw.trim()] ?? raw.trim();
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("无法连接 Alpha 本机服务", 0);
  }
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new ApiError(describeError(body.error, `请求失败（HTTP ${response.status}）`), response.status);
  return body as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, body === undefined
    ? { method: "POST" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

export const api = {
  tasks: () => request<TaskList>("/api/tasks"),
  task: (id: string) => request<{ task: TaskView }>(taskPath(id)).then(result => result.task),
  activity: (id: string) => request<{ entries: ActivityEntry[] }>(`${taskPath(id)}/activity`).then(result => result.entries),
  reviews: (id: string) => request<{ reviews: ReviewSummary[] }>(`${taskPath(id)}/reviews`).then(result => result.reviews),
  review: (id: string, operationId: string) => request<{ review: ReviewDetail }>(`${taskPath(id)}/reviews/${encodeURIComponent(operationId)}`).then(result => result.review),
  evidence: (id: string, evidenceId: string) => request<EvidenceDetail>(`${taskPath(id)}/evidence/${encodeURIComponent(evidenceId)}`),
  control: () => request<{ holder: ControlHolder }>("/api/browser/control").then(result => result.holder),
  setControl: (holder: ControlHolder) => post<{ holder: ControlHolder }>("/api/browser/control", { holder }),
  start: (brief: string) => post<{ runId: string }>("/api/tasks", { brief }),
  revise: (id: string, brief: string) => post<{ runId: string }>(`${taskPath(id)}/revise`, { brief }),
  resume: (id: string, brief: string) => post<{ runId: string }>(`${taskPath(id)}/resume`, { brief }),
  guidance: (id: string, text: string) => post<{ id: string; status?: string }>(`${taskPath(id)}/guidance`, { text }),
  cancel: (runId: string) => post<{ stopping: boolean }>(`/api/tasks/${encodeURIComponent(runId)}/cancel`),
  verify: (id: string) => post<{ task?: TaskView; paused?: boolean }>(`${taskPath(id)}/verify`),
  /** Publication may finish even when its reply is lost, so only an explicit refusal counts as rejected; callers re-query the task. */
  async publish(id: string): Promise<{ rejected: string | null }> {
    try {
      const response = await fetch(`${taskPath(id)}/publish`, { method: "POST" });
      if (response.ok || response.status === 409) return { rejected: null };
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      return { rejected: describeError(body.error, `重新发布失败（HTTP ${response.status}）`) };
    } catch {
      return { rejected: null };
    }
  },
};
