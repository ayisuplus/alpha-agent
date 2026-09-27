import type { ActivityEntry, AgentPreset, AgentPresetSummary, Automation, AutomationRun, ControlHolder, Diagnostics, EvidenceDetail, LocalSchedule, ModelCatalog, PermissionMode, ProjectRecord, PromptRefinement, QueueItem, ReviewDetail, ReviewSummary, Settings, SettingsPatch, SkillPlugin, StorageReport, TaskList, TaskMeta, TaskView } from "./types";

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

function send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  return request<T>(path, body === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const post = <T>(path: string, body?: unknown) => send<T>("POST", path, body);

const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

export const api = {
  settings: () => request<{ settings: Settings }>("/api/settings").then(result => result.settings),
  updateSettings: (patch: SettingsPatch) => send<{ settings: Settings }>("PUT", "/api/settings", patch).then(result => result.settings),
  agentPresets: () => request<{ presets: AgentPresetSummary[] }>("/api/agent-presets").then(result => result.presets),
  agentPresetTemplates: () => request<{ presets: AgentPresetSummary[] }>("/api/agent-presets/templates").then(result => result.presets),
  agentPreset: (id: string) => request<{ preset: AgentPreset }>(`/api/agent-presets/${encodeURIComponent(id)}`).then(result => result.preset),
  createAgentPreset: (draft: Pick<AgentPreset, "name" | "description" | "instructions"> & { skillIds?: string[] }) => post<{ preset: AgentPreset }>("/api/agent-presets", draft).then(result => result.preset),
  deleteAgentPreset: (id: string) => send<{ deleted: boolean }>("DELETE", `/api/agent-presets/${encodeURIComponent(id)}`, {}).then(result => result.deleted),
  decideSkillProposal: (taskId: string, proposalId: string, decision: "install" | "reject") => post<{ task: TaskView }>(`/api/tasks/${encodeURIComponent(taskId)}/skills/${encodeURIComponent(proposalId)}/decision`, { decision }).then(result => result.task),
  setAgentPresetEnabled: (id: string, enabled: boolean) => send<{ preset: AgentPreset }>("PATCH", `/api/agent-presets/${encodeURIComponent(id)}`, { enabled }).then(result => result.preset),
  copyAgentPreset: (id: string) => post<{ preset: AgentPreset }>(`/api/agent-presets/${encodeURIComponent(id)}/copy`, {}).then(result => result.preset),
  updateAgentPreset: (id: string, patch: Pick<AgentPreset, "name" | "description" | "instructions"> & { skillIds?: string[] }) => send<{ preset: AgentPreset }>("PUT", `/api/agent-presets/${encodeURIComponent(id)}`, patch).then(result => result.preset),
  plugins: () => request<{ plugins: SkillPlugin[] }>("/api/plugins").then(result => result.plugins),
  capabilities: () => request<{ plugins: SkillPlugin[]; skills: Array<{ id: string; name: string; description: string }> }>("/api/capabilities"),
  installPlugin: (source: string) => post<{ plugin: SkillPlugin }>("/api/plugins/install", { source }).then(result => result.plugin),
  setPluginEnabled: (id: string, enabled: boolean) => send<{ plugin: SkillPlugin }>("PATCH", `/api/plugins/${encodeURIComponent(id)}`, { enabled }).then(result => result.plugin),
  setPluginHooksEnabled: (id: string, hooksEnabled: boolean) => send<{ plugin: SkillPlugin }>("PATCH", `/api/plugins/${encodeURIComponent(id)}`, { hooksEnabled }).then(result => result.plugin),
  setPluginMCPEnabled: (id: string, mcpEnabled: boolean) => send<{ plugin: SkillPlugin }>("PATCH", `/api/plugins/${encodeURIComponent(id)}`, { mcpEnabled }).then(result => result.plugin),
  checkPluginMCP: (id: string) => post<{ tools: string[]; errors: string[] }>(`/api/plugins/${encodeURIComponent(id)}/mcp/check`, {}),
  mcpPermissions: (id: string) => request<{ permissions: Record<string, "deny" | "read" | "write"> }>(`/api/plugins/${encodeURIComponent(id)}/mcp/permissions`).then(result => result.permissions),
  setMCPPermission: (id: string, tool: string, permission: "deny" | "read" | "write") => send<{ permissions: Record<string, "deny" | "read" | "write"> }>("PUT", `/api/plugins/${encodeURIComponent(id)}/mcp/permissions`, { tool, permission }).then(result => result.permissions),
  checkGeneration: (url: string) => post<{ url: string; online: boolean }>("/api/generation/check", { url }),
  models: () => request<ModelCatalog>("/api/models"),
  webProviders: () => request<{ providers: Array<{ id: "tavily" | "firecrawl"; configured: boolean; source: string }>; desktopBrowser: boolean }>("/api/web/providers"),
  setWebKey: (provider: "tavily" | "firecrawl", key: string) => send<{ saved: boolean }>("PUT", `/api/web/providers/${provider}/key`, { key }),
  removeWebKey: (provider: "tavily" | "firecrawl") => send<{ removed: boolean }>("DELETE", `/api/web/providers/${provider}/key`),
  diagnostics: () => request<Diagnostics>("/api/diagnostics"),
  storage: () => request<StorageReport>("/api/storage"),
  cleanupPreviews: () => post<{ removed: number; bytes: number }>("/api/storage/cleanup-previews"),
  testModel: (model: string) => post<{ ok: boolean; latencyMs: number; error?: string }>("/api/models/test", { model }),
  refinePrompt: (prompt: string, model?: string | null) => post<{ result: PromptRefinement }>("/api/prompts/refine", { prompt, model: model ?? undefined }).then(response => response.result),
  setApiKey: (provider: string, apiKey: string) => send<{ saved: boolean }>("PUT", `/api/providers/${encodeURIComponent(provider)}/key`, { apiKey }),
  removeApiKey: (provider: string) => send<{ removed: number }>("DELETE", `/api/providers/${encodeURIComponent(provider)}/key`),
  setTaskModel: (id: string, model: string | null) => post<{ task: TaskView }>(`${taskPath(id)}/model`, { model }).then(result => result.task),
  updateTaskMeta: (id: string, patch: TaskMeta) => send<{ task: TaskView }>("PATCH", `${taskPath(id)}/meta`, patch).then(result => result.task),
  tasks: () => request<TaskList>("/api/tasks"),
  task: (id: string) => request<{ task: TaskView }>(taskPath(id)).then(result => result.task),
  worker: (taskId: string, id: string) => request<{ instance: NonNullable<NonNullable<TaskView["cognition"]>["instances"]>[number]; report?: { status: string; changes: Record<string, string[]>; reason?: string; results: Record<string, { findings?: string[]; unresolved?: string[] }> }; diff?: string; events: Array<{ sequence: number; type: string; value: string }> }>(`${taskPath(taskId)}/workers/${encodeURIComponent(id)}`),
  agentMessages: (taskId: string) => request<{ messages: Array<{ id: string; fromAgentId: string | null; fromRunId: string | null; toAgentId: string | null; kind: string; body: string; recordedAt: string; contractVersion: number; baseRevision: string | null }> }>(`${taskPath(taskId)}/agents/messages`),
  cancelWorker: (taskId: string, id: string) => post<{ task: TaskView }>(`${taskPath(taskId)}/workers/${encodeURIComponent(id)}/cancel`).then(result => result.task),
  projectMemory: (id: string) => request<{ content: string; commit: string | null; checkpoint: TaskView["checkpoint"]; error: string | null }>(`${taskPath(id)}/memory`),
  webApprovals: (id: string) => request<{ approvals: import("./types").WebApproval[] }>(`${taskPath(id)}/web-approvals`).then(result => result.approvals),
  decideWebApproval: (id: string, approvalId: string, approved: boolean) => post<{ approval: import("./types").WebApproval }>(`${taskPath(id)}/web-approvals/${approvalId}/decision`, { approved }),
  webTabs: (id: string) => request<{ tabs: import("./types").WebTab[] }>(`${taskPath(id)}/web-tabs`).then(result => result.tabs),
  openWebTab: (id: string, url: string) => post<{ tab: import("./types").WebTab }>(`${taskPath(id)}/web-tabs`, { url }).then(result => result.tab),
  webTabAction: (id: string, tabId: string, action: "focus" | "close") => post<{ ok: boolean }>(`${taskPath(id)}/web-tabs/${tabId}/${action}`, {}),
  webSources: (id: string) => request<{ sources: import("./types").WebSource[]; jobs: import("./types").WebJob[] }>(`${taskPath(id)}/web-sources`),
  activity: (id: string) => request<{ entries: ActivityEntry[] }>(`${taskPath(id)}/activity`).then(result => result.entries),
  reviews: (id: string) => request<{ reviews: ReviewSummary[] }>(`${taskPath(id)}/reviews`).then(result => result.reviews),
  review: (id: string, operationId: string) => request<{ review: ReviewDetail }>(`${taskPath(id)}/reviews/${encodeURIComponent(operationId)}`).then(result => result.review),
  evidence: (id: string, evidenceId: string) => request<EvidenceDetail>(`${taskPath(id)}/evidence/${encodeURIComponent(evidenceId)}`),
  control: () => request<{ holder: ControlHolder }>("/api/browser/control").then(result => result.holder),
  projects: () => request<{ projects: ProjectRecord[] }>("/api/projects").then(result => result.projects),
  createProject: (name: string) => post<{ project: ProjectRecord }>("/api/projects", { name }).then(result => result.project),
  setProjectPermission: (projectId: string, permissionMode: PermissionMode) => send<{ project: ProjectRecord }>("PATCH", `/api/projects/${encodeURIComponent(projectId)}/settings`, { permissionMode }).then(result => result.project),
  mountProjectFolder: (projectId: string, path: string) => post<{ project: ProjectRecord }>(`/api/projects/${encodeURIComponent(projectId)}/mounts`, { path }).then(result => result.project),
  unmountProjectFolder: (projectId: string, mountId: string) => send<{ project: ProjectRecord }>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/mounts/${encodeURIComponent(mountId)}`).then(result => result.project),
  checkProjectSandbox: (projectId: string, mountId: string) => post<{ ok: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/sandbox/check`, { mountId }),
  recheckTaskProject: (taskId: string) => post<{ task: TaskView }>(`${taskPath(taskId)}/project/recheck`, {}).then(result => result.task),
  startProjectTask: (projectId: string, mountId: string, objective: string, permissionMode: PermissionMode, model?: string | null, expertId?: string | null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false) => post<{ taskId: string; runId: string }>(`/api/projects/${encodeURIComponent(projectId)}/tasks`, { mountId, objective, permissionMode, model: model ?? null, expertId: expertId ?? null, startMode, continueUntilAccepted }),
  setControl: (holder: ControlHolder) => post<{ holder: ControlHolder }>("/api/browser/control", { holder }),
  start: (brief: string, model?: string | null, expertId?: string | null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false) => post<{ runId: string }>("/api/tasks", { brief, model: model ?? null, expertId: expertId ?? null, startMode, continueUntilAccepted }),
  importWorkspace: (sourcePath: string, objective: string, model?: string | null, expertId?: string | null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false) => post<{ taskId: string; runId: string }>("/api/workspaces/import", { sourcePath, objective, model: model ?? null, expertId: expertId ?? null, startMode, continueUntilAccepted }),
  startWorkflow: (taskType: "research" | "file-work", objective: string, files: File[], model?: string | null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false) => {
    const form = new FormData();
    form.set("taskType", taskType);
    form.set("objective", objective);
    if (model) form.set("model", model);
    form.set("startMode", startMode);
    form.set("continueUntilAccepted", String(continueUntilAccepted));
    files.forEach(file => form.append("files", file));
    return request<{ taskId: string; runId: string }>("/api/workflows", { method: "POST", body: form });
  },
  startGeneral: (input: { objective: string; projectId: string; mountId: string; files: File[]; skillIds: string[]; pluginIds: string[]; model: string | null; startMode: "plan" | "execute"; continueUntilAccepted: boolean }) => {
    const form = new FormData();
    form.set("objective", input.objective);
    if (input.projectId) form.set("projectId", input.projectId);
    if (input.mountId) form.set("mountId", input.mountId);
    if (input.model) form.set("model", input.model);
    form.set("startMode", input.startMode);
    form.set("continueUntilAccepted", String(input.continueUntilAccepted));
    form.set("skillIds", JSON.stringify(input.skillIds));
    form.set("pluginIds", JSON.stringify(input.pluginIds));
    input.files.forEach(file => form.append("files", file));
    return request<{ taskId: string; runId: string | null; queued: boolean }>("/api/tasks/general", { method: "POST", body: form });
  },
  sendMessage: (id: string, input: { text: string; files: File[]; skillIds?: string[]; pluginIds?: string[]; forceRevision?: boolean }) => {
    const form = new FormData();
    form.set("text", input.text);
    if (input.forceRevision) form.set("forceRevision", "true");
    input.files.forEach(file => form.append("files", file));
    if (input.skillIds) form.set("skillIds", JSON.stringify(input.skillIds));
    if (input.pluginIds) form.set("pluginIds", JSON.stringify(input.pluginIds));
    return request<{ taskId: string; runId?: string; contractVersion?: number; delivered?: boolean }>(`${taskPath(id)}/messages`, { method: "POST", body: form });
  },
  taskQueue: () => request<{ items: QueueItem[]; schedules: LocalSchedule[] }>("/api/queue"),
  automations: () => request<{ automations: Automation[]; runs: AutomationRun[] }>("/api/automations"),
  createAutomation: (input: Pick<Automation, "name" | "prompt" | "kind" | "schedule" | "modelSelector" | "notificationPolicy"> & Partial<Pick<Automation, "projectId" | "mountId" | "targetTaskId">>) => post<{ automation: Automation }>("/api/automations", input),
  updateAutomation: (id: string, patch: Partial<Automation>) => send<{ automation: Automation }>("PATCH", `/api/automations/${encodeURIComponent(id)}`, patch),
  deleteAutomation: (id: string) => send<{ deleted: boolean }>("DELETE", `/api/automations/${encodeURIComponent(id)}`),
  runAutomation: (id: string) => post<{ run: AutomationRun }>(`/api/automations/${encodeURIComponent(id)}/run`),
  readAutomationRun: (id: string) => post<{ read: boolean }>(`/api/automation-runs/${encodeURIComponent(id)}/read`),
  enqueueTask: (taskId: string, instruction: string) => post<{ item: QueueItem }>("/api/queue", { taskId, instruction }),
  cancelQueuedTask: (id: string) => send<{ cancelled: boolean }>("DELETE", `/api/queue/${encodeURIComponent(id)}`),
  scheduleTask: (taskId: string, instruction: string, nextRunAt: string, intervalMinutes: number | null) => post<{ schedule: LocalSchedule }>("/api/schedules", { taskId, instruction, nextRunAt, intervalMinutes }),
  disableSchedule: (id: string) => send<{ disabled: boolean }>("DELETE", `/api/schedules/${encodeURIComponent(id)}`),
  applyReview: (id: string) => request<{ revision: string | null; changes: Array<{ path: string; action: string; conflict: boolean }>; conflicts: string[] }>(`${taskPath(id)}/apply-review`),
  applyCode: (id: string, revision: string) => post<{ applied: Array<{ path: string; action: string }> }>(`${taskPath(id)}/apply`, { revision }),
  approvals: (id: string) => request<{ approvals: import("./types").CommandApproval[] }>(`${taskPath(id)}/approvals`).then(result => result.approvals),
  decideApproval: (id: string, approvalId: string, approved: boolean) => post<{ approval: import("./types").CommandApproval }>(`${taskPath(id)}/approvals/${encodeURIComponent(approvalId)}/decision`, { approved }),
  revise: (id: string, brief: string) => post<{ runId: string }>(`${taskPath(id)}/revise`, { brief }),
  resume: (id: string, brief: string) => post<{ runId: string }>(`${taskPath(id)}/resume`, { brief }),
  enterPlan: (id: string) => post<{ runId: string }>(`${taskPath(id)}/plan/enter`, {}),
  approvePlan: (id: string, expected: { contractVersion: number; cognitionRevision: number; sourceRevision: string }) => post<{ runId: string }>(`${taskPath(id)}/plan/approve`, expected),
  setGoal: (id: string, enabled: boolean) => send<{ task: TaskView }>("PATCH", `${taskPath(id)}/goal`, { enabled }).then(result => result.task),
  guidance: (id: string, text: string) => post<{ id: string; status?: string }>(`${taskPath(id)}/guidance`, { text }),
  cancel: (runId: string) => post<{ stopping: boolean }>(`/api/tasks/${encodeURIComponent(runId)}/cancel`),
  cancelOperation: (id: string) => post<{ stopping: boolean }>(`/api/operations/${encodeURIComponent(id)}/cancel`),
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
