import { api } from "../api/client";
import { connectEvents, type ConnectionState } from "../api/events";
import type { ActivityEntry, ControlHolder, ModelCatalog, ReviewSummary, ServerMessage, Settings, SettingsPatch, TaskList, TaskSummary, TaskView } from "../api/types";
import { TERMINAL_PHASES } from "./labels";
import { createStore } from "./store";
import { mergeActivity } from "./timeline";

export type Detail = { kind: "diff"; operationId: string } | { kind: "evidence"; criterionId?: string; evidenceId?: string };
export type PendingAction = "start" | "resume" | "revise" | "guidance" | "stop" | "publish" | "verify" | "control";
export type SettingsSection = "model" | "run" | "generation" | "interface" | "workspace" | "diagnostics" | "shortcuts";
export type Panel = { kind: "settings"; section: SettingsSection };

export interface AppState {
  loaded: boolean;
  tasks: TaskSummary[];
  /** The task whose model run holds the single execution slot, as reported by the server. */
  activeTaskId: string | null;
  activeRunId: string | null;
  selectedId: string | null;
  task: TaskView | null;
  activity: ActivityEntry[];
  reviews: ReviewSummary[];
  /** Streamed model text for the selected task that has not yet been flushed into an activity entry. */
  liveText: string;
  /** Any server operation in progress (model run, publication or verification), from status events. */
  operation: { taskId: string | null; phase: string } | null;
  runningPreview: { taskId: string; url: string } | null;
  controlHolder: ControlHolder;
  connection: ConnectionState;
  pending: PendingAction | null;
  starting: { brief: string; error: string | null } | null;
  notice: { id: number; tone: "error" | "info"; text: string } | null;
  detail: Detail | null;
  /** A workbench-level page shown in the middle column instead of the task (currently only settings). */
  panel: Panel | null;
  settings: Settings | null;
  /** Loaded on demand (settings, model pickers); lists every tool-capable model and whether it can be used. */
  models: ModelCatalog | null;
}

export const store = createStore<AppState>({
  loaded: false,
  tasks: [],
  activeTaskId: null,
  activeRunId: null,
  selectedId: null,
  task: null,
  activity: [],
  reviews: [],
  liveText: "",
  operation: null,
  runningPreview: null,
  controlHolder: "alpha",
  connection: "connecting",
  pending: null,
  starting: null,
  notice: null,
  detail: null,
  panel: null,
  settings: null,
  models: null,
});

export function isOccupied(state: AppState): boolean {
  return state.activeRunId !== null || state.operation !== null || state.pending !== null;
}

const SELECTED_KEY = "alpha.selectedTask";

function remember(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(SELECTED_KEY, id);
    else sessionStorage.removeItem(SELECTED_KEY);
  } catch { /* Selection memory is a convenience only. */ }
}

function recalled(): string | null {
  try { return sessionStorage.getItem(SELECTED_KEY); } catch { return null; }
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let noticeId = 0;
export function notify(text: string, tone: "error" | "info" = "error"): void {
  store.set({ notice: { id: ++noticeId, tone, text } });
}

export function dismissNotice(id: number): void {
  if (store.get().notice?.id === id) store.set({ notice: null });
}

function upsertSummary(tasks: TaskSummary[], task: TaskView): TaskSummary[] {
  const summary: TaskSummary = {
    id: task.id, objective: task.objective, originalObjective: task.originalObjective, contractVersion: task.contractVersion,
    status: task.status, running: task.running, pendingCount: task.pending.length, createdAt: task.createdAt, updatedAt: task.updatedAt,
    modelSelector: task.modelSelector,
  };
  const index = tasks.findIndex(item => item.id === task.id);
  if (index < 0) return [summary, ...tasks];
  const next = [...tasks];
  next[index] = summary;
  return next;
}

async function loadRunningPreview(id: string): Promise<void> {
  const task = await api.task(id).catch(() => null);
  if (task?.preview?.live && store.get().activeTaskId === id) store.set({ runningPreview: { taskId: id, url: task.preview.url } });
}

export async function refreshTasks(): Promise<TaskList | null> {
  let list: TaskList;
  try { list = await api.tasks(); } catch { return null; }
  const previous = store.get();
  store.set({
    loaded: true, tasks: list.tasks, activeTaskId: list.activeTaskId, activeRunId: list.activeRunId,
    runningPreview: list.activeTaskId ? previous.runningPreview : null,
  });
  if (list.activeTaskId && list.activeTaskId !== previous.activeTaskId) void loadRunningPreview(list.activeTaskId);
  const state = store.get();
  if (state.starting && !state.starting.error && state.selectedId === null && list.activeTaskId) void openTask(list.activeTaskId);
  return list;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleTasksRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshTasks(), 400);
}

/** Refetches the selected task; results for a task that is no longer selected are dropped. */
export async function syncSelected(id: string): Promise<void> {
  const [task, activity, reviews] = await Promise.allSettled([api.task(id), api.activity(id), api.reviews(id)]);
  if (store.get().selectedId !== id) return;
  store.set(state => ({
    task: task.status === "fulfilled" ? task.value : state.task,
    activity: activity.status === "fulfilled" ? mergeActivity(state.activity, activity.value) : state.activity,
    reviews: reviews.status === "fulfilled" ? reviews.value : state.reviews,
  }));
  if (task.status === "rejected") notify(messageOf(task.reason));
}

export async function openTask(id: string): Promise<void> {
  const state = store.get();
  if (state.selectedId !== id) {
    store.set({ selectedId: id, task: null, activity: [], reviews: [], liveText: "", detail: null, starting: null, panel: null });
  } else store.set({ starting: null, panel: null });
  remember(id);
  await syncSelected(id);
}

export function newTask(): void {
  store.set({ selectedId: null, task: null, activity: [], reviews: [], liveText: "", detail: null, starting: null, panel: null });
  remember(null);
}

export function openDetail(detail: AppState["detail"]): void {
  store.set({ detail });
}

let modelsRequest: Promise<ModelCatalog | null> | null = null;

export function loadModels(force = false): Promise<ModelCatalog | null> {
  if (!force && store.get().models) return Promise.resolve(store.get().models);
  if (!force && modelsRequest) return modelsRequest;
  modelsRequest = api.models()
    .then(models => { store.set({ models }); return models; })
    .catch(error => { notify(messageOf(error)); return null; })
    .finally(() => { modelsRequest = null; });
  return modelsRequest;
}

export async function saveApiKey(provider: string, key: string): Promise<boolean> {
  try {
    await api.setApiKey(provider, key);
    await loadModels(true);
    notify("API Key 已保存", "info");
    return true;
  } catch (error) {
    notify(messageOf(error));
    return false;
  }
}

export async function deleteApiKey(provider: string): Promise<void> {
  try {
    await api.removeApiKey(provider);
    await loadModels(true);
    notify("API Key 已删除", "info");
  } catch (error) { notify(messageOf(error)); }
}

export async function setTaskModel(model: string | null): Promise<void> {
  const task = store.get().task;
  if (!task) return;
  try {
    const updated = await api.setTaskModel(task.id, model);
    if (store.get().selectedId === updated.id) store.set({ task: updated });
  } catch (error) { notify(messageOf(error)); }
}

export function openSettings(section: SettingsSection = "model"): void {
  store.set({ panel: { kind: "settings", section } });
}

export function closePanel(): void {
  store.set({ panel: null });
}

function applyPatch(settings: Settings, patch: SettingsPatch): Settings {
  const next = { ...settings };
  for (const key of Object.keys(patch) as Array<keyof SettingsPatch>) {
    (next as Record<string, unknown>)[key] = { ...settings[key], ...patch[key] };
  }
  return next;
}

function combinePatches(first: SettingsPatch, second: SettingsPatch): SettingsPatch {
  const next: Record<string, unknown> = { ...first };
  for (const key of Object.keys(second) as Array<keyof SettingsPatch>) next[key] = { ...first[key], ...second[key] };
  return next as SettingsPatch;
}

let unsentSettings: SettingsPatch = {};
let settingsTimer: ReturnType<typeof setTimeout> | undefined;

async function flushSettings(): Promise<boolean> {
  clearTimeout(settingsTimer);
  const patch = unsentSettings;
  unsentSettings = {};
  if (!Object.keys(patch).length) return true;
  try {
    const saved = await api.updateSettings(patch);
    store.set({ settings: applyPatch(saved, unsentSettings) });
    return true;
  } catch (error) {
    notify(messageOf(error));
    const current = await api.settings().catch(() => null);
    if (current) store.set({ settings: applyPatch(current, unsentSettings) });
    return false;
  }
}

/**
 * Applies a settings change immediately and saves it. Layout changes (dragging, toggling) pass `debounce` so a burst
 * of updates becomes one write; a newer local change is never overwritten by an older server reply.
 */
export function updateSettings(patch: SettingsPatch, options: { debounce?: boolean } = {}): Promise<boolean> {
  store.set(state => ({ settings: state.settings ? applyPatch(state.settings, patch) : state.settings }));
  unsentSettings = combinePatches(unsentSettings, patch);
  if (!options.debounce) return flushSettings();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => void flushSettings(), 400);
  return Promise.resolve(true);
}

/** Publication and verification need the visible preview, so a collapsed preview pane opens itself for them. */
function revealPreviewForBrowserWork(): void {
  if (store.get().settings?.ui.previewCollapsed) void updateSettings({ ui: { previewCollapsed: false } }, { debounce: true });
}

export function previewLocked(state: AppState): boolean {
  return state.controlHolder === "user" || state.operation !== null;
}

function handleMessage(message: ServerMessage): void {
  const state = store.get();
  switch (message.type) {
    case "activity":
      if (message.taskId === state.selectedId) {
        store.set(current => ({
          activity: mergeActivity(current.activity, [message.entry]),
          liveText: message.entry.kind === "text" ? "" : current.liveText,
        }));
      }
      break;
    case "text":
      if (message.taskId && message.taskId === state.selectedId) store.set(current => ({ liveText: current.liveText + message.value }));
      break;
    case "task": {
      const task = message.task;
      store.set(current => ({
        tasks: upsertSummary(current.tasks, task),
        task: current.selectedId === task.id ? task : current.task,
        runningPreview: current.runningPreview?.taskId === task.id && !task.preview?.live ? null : current.runningPreview,
      }));
      if (state.starting && !state.starting.error && state.selectedId === null && task.running) void openTask(task.id);
      scheduleTasksRefresh();
      break;
    }
    case "settings":
      store.set({ settings: applyPatch(message.settings, unsentSettings) });
      break;
    case "status": {
      const terminal = TERMINAL_PHASES.has(message.phase);
      store.set({ operation: terminal ? null : { taskId: message.taskId ?? null, phase: message.phase } });
      if (message.phase === "发布本机预览" || message.phase === "浏览器验收") revealPreviewForBrowserWork();
      if (!terminal) break;
      if (!message.taskId && state.starting && !state.starting.error) {
        store.set({ starting: { ...state.starting, error: "任务未能启动" } });
      }
      void refreshTasks();
      if (message.taskId && message.taskId === state.selectedId) {
        store.set({ liveText: "" });
        void syncSelected(message.taskId);
      }
      break;
    }
    case "preview":
      revealPreviewForBrowserWork();
      if (message.taskId) {
        store.set({ runningPreview: { taskId: message.taskId, url: message.url } });
        if (message.taskId === state.selectedId) void syncSelected(message.taskId);
      }
      break;
    case "control":
      store.set({ controlHolder: message.holder });
      break;
    case "error":
      if (!message.taskId && state.starting) store.set({ starting: { ...state.starting, error: message.message } });
      break;
  }
}

async function loadSettings(): Promise<void> {
  const settings = await api.settings().catch(() => null);
  if (settings) store.set({ settings: applyPatch(settings, unsentSettings) });
}

async function resync(): Promise<void> {
  await Promise.all([refreshTasks(), loadSettings()]);
  const id = store.get().selectedId;
  if (id) await syncSelected(id);
  const holder = await api.control().catch(() => null);
  if (holder) store.set({ controlHolder: holder });
}

export function startWorkbench(): () => void {
  const disconnect = connectEvents({
    onMessage: handleMessage,
    onState: connection => store.set({ connection }),
    onReconnect: () => {
      // Status events may have been missed while disconnected; the server state is re-read instead.
      store.set({ operation: null });
      void resync();
    },
  });
  void (async () => {
    const [list] = await Promise.all([refreshTasks(), loadSettings()]);
    const saved = recalled();
    const id = list?.tasks.find(task => task.id === saved)?.id ?? list?.activeTaskId ?? list?.tasks[0]?.id;
    if (id) void openTask(id);
    const holder = await api.control().catch(() => null);
    if (holder) store.set({ controlHolder: holder });
  })();
  const poll = setInterval(() => {
    const state = store.get();
    if (state.activeRunId || state.operation) void resync();
  }, 15_000);
  let lastFocus = 0;
  const onFocus = () => {
    if (Date.now() - lastFocus < 3_000) return;
    lastFocus = Date.now();
    void resync();
  };
  window.addEventListener("focus", onFocus);
  const onUnload = () => void flushSettings();
  window.addEventListener("beforeunload", onUnload);
  return () => {
    window.removeEventListener("beforeunload", onUnload);
    disconnect();
    clearInterval(poll);
    window.removeEventListener("focus", onFocus);
  };
}

async function perform<T>(action: PendingAction, work: () => Promise<T>): Promise<T | undefined> {
  if (store.get().pending) return undefined;
  store.set({ pending: action });
  try {
    return await work();
  } catch (error) {
    notify(messageOf(error));
    return undefined;
  } finally {
    store.set({ pending: null });
  }
}

export async function startTask(brief: string, model: string | null = null): Promise<void> {
  const text = brief.trim();
  if (!text || store.get().pending) return;
  store.set({ pending: "start", starting: { brief: text, error: null } });
  try {
    const { runId } = await api.start(text, model);
    store.set({ activeRunId: runId });
  } catch (error) {
    store.set({ starting: { brief: text, error: messageOf(error) } });
  } finally {
    store.set({ pending: null });
  }
}

export function clearStarting(): void {
  store.set({ starting: null });
}

async function afterLaunch(taskId: string, runId: string): Promise<void> {
  store.set({ activeRunId: runId, activeTaskId: taskId });
  await Promise.all([refreshTasks(), syncSelected(taskId)]);
}

export async function resumeTask(instruction: string): Promise<boolean> {
  const task = store.get().task;
  if (!task) return false;
  const result = await perform("resume", () => api.resume(task.id, instruction.trim()));
  if (!result) return false;
  await afterLaunch(task.id, result.runId);
  return true;
}

export async function reviseTask(objective: string): Promise<boolean> {
  const task = store.get().task;
  const text = objective.trim();
  if (!task || !text || text === task.objective) return false;
  const result = await perform("revise", () => api.revise(task.id, text));
  if (!result) return false;
  await afterLaunch(task.id, result.runId);
  return true;
}

/** Records guidance: delivered to the running model session when one accepts it, otherwise kept for the next run. */
export async function sendGuidance(text: string): Promise<boolean> {
  const task = store.get().task;
  if (!task || !text.trim()) return false;
  const result = await perform("guidance", () => api.guidance(task.id, text.trim()));
  if (!result) return false;
  await syncSelected(task.id);
  return true;
}

export async function stopTask(): Promise<void> {
  const { task, activeRunId } = store.get();
  if (!task?.running || !activeRunId) return;
  const result = await perform("stop", () => api.cancel(activeRunId));
  if (result) notify("正在停止本轮运行…", "info");
}

export async function republish(): Promise<void> {
  const task = store.get().task;
  if (!task) return;
  await perform("publish", async () => {
    const live = async () => {
      const fresh = await api.task(task.id);
      if (store.get().selectedId === task.id) store.set({ task: fresh });
      return !!fresh.preview?.live;
    };
    if (await live()) return;
    const { rejected } = await api.publish(task.id);
    if (rejected) throw new Error(rejected);
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await live()) return;
      await sleep(500);
    }
    throw new Error("发布结果未确认，请稍后查看任务状态");
  });
  void refreshTasks();
}

export async function verifyTask(): Promise<void> {
  const task = store.get().task;
  if (!task) return;
  await perform("verify", async () => {
    try {
      await api.verify(task.id);
    } catch (error) {
      if ((error as { status?: number }).status === 422) throw new Error("浏览器验收未通过，失败原因已记录在时间线和证据里");
      throw error;
    }
  });
  await syncSelected(task.id);
}

export async function toggleControl(): Promise<void> {
  const holder: ControlHolder = store.get().controlHolder === "alpha" ? "user" : "alpha";
  const result = await perform("control", () => api.setControl(holder));
  if (!result) return;
  store.set({ controlHolder: holder });
  const state = store.get();
  const task = state.task;
  if (holder === "alpha" && task?.status === "active" && task.preview?.live && task.pending.includes("user-path") && !isOccupied(state)) void verifyTask();
}
