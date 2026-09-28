import { api } from "../api/client";
import { connectEvents, type ConnectionState } from "../api/events";
import type { ActivityEntry, ControlHolder, ModelCatalog, OperationSnapshot, ProjectRecord, ReviewSummary, RunInfo, ServerMessage, Settings, SettingsPatch, TaskList, TaskMeta, TaskSummary, TaskTimelineEvent, TaskView } from "../api/types";
import { TERMINAL_PHASES, taskTitle } from "./labels";
import { buildTaskReport } from "./report";
import { createStore } from "./store";
import { mergeActivity, mergeTaskEvents } from "./timeline";

export type Detail = { kind: "diff"; operationId: string } | { kind: "evidence"; criterionId?: string; evidenceId?: string } | { kind: "info" };
export type PendingAction = "start" | "resume" | "revise" | "guidance" | "ask" | "stop" | "publish" | "verify" | "control" | "plan" | "approve" | "goal";
export type SettingsSection = "model" | "run" | "agents" | "generation" | "web" | "interface" | "workspace" | "diagnostics" | "shortcuts";
export type Panel = { kind: "settings"; section: SettingsSection } | { kind: "automations" };

export interface AppState {
  loaded: boolean;
  tasks: TaskSummary[];
  projects: ProjectRecord[];
  /** Model runs in progress; tasks run side by side up to the configured limit. */
  runs: RunInfo[];
  /** Every server operation in progress (model runs, answers, publications, verifications, cleanups) with its phase. */
  operations: OperationSnapshot[];
  selectedId: string | null;
  task: TaskView | null;
  activity: ActivityEntry[];
  reviews: ReviewSummary[];
  /** The selected task's durable event track, rebuilt from its log, so it survives a server restart. */
  events: TaskTimelineEvent[];
  /** Sequence number of the last event log row read for the selected task; the `since` cursor of the next refresh. */
  eventSeq: number;
  /** Streamed model text for the selected task that has not yet been flushed into an activity entry. */
  liveText: string;
  runningPreview: { taskId: string; url: string } | null;
  controlHolder: ControlHolder;
  connection: ConnectionState;
  pending: PendingAction | null;
  /** A new task being started from the new-task page; `runId` identifies its run once the server has accepted it. */
  starting: { brief: string; error: string | null; runId?: string | null } | null;
  notice: { id: number; tone: "error" | "info"; text: string } | null;
  detail: Detail | null;
  workspaceView: "closed" | "preview" | "detail" | "terminal";
  browserTabId: string | null;
  /** A workbench-level page shown in the middle column instead of the task (currently only settings). */
  panel: Panel | null;
  settings: Settings | null;
  /** Loaded on demand (settings, model pickers); lists every tool-capable model and whether it can be used. */
  models: ModelCatalog | null;
  paletteOpen: boolean;
}

export const store = createStore<AppState>({
  loaded: false,
  tasks: [],
  projects: [],
  runs: [],
  operations: [],
  selectedId: null,
  task: null,
  activity: [],
  reviews: [],
  events: [],
  eventSeq: 0,
  liveText: "",
  runningPreview: null,
  controlHolder: "alpha",
  connection: "connecting",
  pending: null,
  starting: null,
  notice: null,
  detail: null,
  workspaceView: "closed",
  browserTabId: null,
  panel: null,
  settings: null,
  models: null,
  paletteOpen: false,
});

export function runOf(state: AppState, taskId: string): RunInfo | null {
  return state.runs.find(run => run.taskId === taskId) ?? null;
}

export function operationOf(state: AppState, taskId: string): OperationSnapshot | null {
  return state.operations.find(item => item.taskId === taskId) ?? null;
}

/** Whether the task has work in progress on the server: a model run, an answer, a publication or a verification. */
export function taskBusy(state: AppState, taskId: string): boolean {
  return !!runOf(state, taskId) || !!operationOf(state, taskId);
}

/** The phase of the task's work in progress, until that work settles. */
export function taskPhase(state: AppState, taskId: string): string | null {
  const phase = operationOf(state, taskId)?.phase;
  return phase && !TERMINAL_PHASES.has(phase) ? phase : null;
}

/** The task whose page the one visible preview browser is working in, if any. */
export function browserOwner(state: AppState): string | null {
  return state.operations.find(item => item.browserTaskId)?.browserTaskId ?? state.operations.find(item => item.phase === "浏览器验收")?.taskId ?? null;
}

/** Whether an action on the task has to wait: this window is already sending one, or the task has work in progress. */
export function isOccupied(state: AppState, taskId: string | null): boolean {
  return state.pending !== null || (taskId !== null && taskBusy(state, taskId));
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
    status: task.status, running: task.running, runKind: task.runKind, pendingCount: task.pending.length, createdAt: task.createdAt, updatedAt: task.updatedAt,
    modelSelector: task.modelSelector, meta: task.meta, projectId: task.projectId, projectVersion: task.projectVersion,
    permissionMode: task.permissionMode, taskType: task.taskType, workspaceOrigin: task.workspaceOrigin,
    designatedExpertId: task.designatedExpertId, phase: task.phase, goal: task.goal, queued: task.queued,
  };
  const index = tasks.findIndex(item => item.id === task.id);
  if (index < 0) return [summary, ...tasks];
  const next = [...tasks];
  next[index] = summary;
  return next;
}

async function loadRunningPreview(id: string): Promise<void> {
  const task = await api.task(id).catch(() => null);
  const state = store.get();
  if (task?.preview?.live && browserOwner(state) === id) store.set({ runningPreview: { taskId: id, url: task.preview.url } });
}

/** When a task takes the visible browser (for verification), shows the browser and loads that task's page. */
function followBrowser(previous: AppState): void {
  const owner = browserOwner(store.get());
  if (!owner || owner === browserOwner(previous)) return;
  revealPreviewForBrowserWork();
  void loadRunningPreview(owner);
}

/** Opens the task a new-task start created, once the server reports which task its run belongs to. */
function openStarted(): void {
  const { starting, runs, selectedId } = store.get();
  if (!starting?.runId || starting.error || selectedId !== null) return;
  const taskId = runs.find(run => run.runId === starting.runId)?.taskId;
  if (taskId) void openTask(taskId);
}

let tasksRequestVersion = 0;
let selectedRequestVersion = 0;
export async function refreshTasks(): Promise<TaskList | null> {
  const version = ++tasksRequestVersion;
  let list: TaskList;
  try { list = await api.tasks(); } catch { return null; }
  if (version !== tasksRequestVersion) return null;
  const previous = store.get();
  const shown = previous.runningPreview;
  store.set({
    loaded: true, tasks: list.tasks, runs: list.runs, operations: list.operations,
    runningPreview: shown && list.operations.some(item => item.taskId === shown.taskId) ? shown : null,
  });
  followBrowser(previous);
  openStarted();
  return list;
}

export async function refreshProjects(): Promise<void> {
  try { store.set({ projects: await api.projects() }); }
  catch { /* Project navigation remains usable with the last loaded list. */ }
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleTasksRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshTasks(), 400);
}

/** Refetches the selected task; results for a task that is no longer selected are dropped. */
export async function syncSelected(id: string): Promise<void> {
  const version = ++selectedRequestVersion;
  // The event cursor belongs to the selected task; a sync for another one (after an approval) leaves it alone.
  const selected = store.get().selectedId === id;
  const since = selected ? store.get().eventSeq : 0;
  const [task, activity, reviews, events] = await Promise.allSettled([api.task(id), api.activity(id), api.reviews(id), selected ? api.taskEvents(id, since) : Promise.resolve(null)]);
  if (store.get().selectedId !== id || version !== selectedRequestVersion) return;
  store.set(state => ({
    task: task.status === "fulfilled" ? task.value : state.task,
    activity: activity.status === "fulfilled" ? mergeActivity(state.activity, activity.value) : state.activity,
    reviews: reviews.status === "fulfilled" ? reviews.value : state.reviews,
    events: events.status === "fulfilled" && events.value ? mergeTaskEvents(state.events, events.value.events) : state.events,
    eventSeq: events.status === "fulfilled" && events.value ? Math.max(state.eventSeq, events.value.seq) : state.eventSeq,
  }));
  if (task.status === "rejected") notify(messageOf(task.reason));
}

/** Appends the durable rows recorded since the cursor; the server pushes `{ type: "task" }` after every mutation. */
export async function refreshTaskEvents(id: string): Promise<void> {
  const since = store.get().eventSeq;
  const result = await api.taskEvents(id, since).catch(() => null);
  if (!result) return;
  store.set(state => state.selectedId === id
    ? { events: mergeTaskEvents(state.events, result.events), eventSeq: Math.max(state.eventSeq, result.seq) }
    : state);
}

export async function openTask(id: string): Promise<void> {
  const state = store.get();
  if (state.selectedId !== id) {
    store.set({ selectedId: id, task: null, activity: [], reviews: [], events: [], eventSeq: 0, liveText: "", detail: null, workspaceView: previewLocked(state) ? "preview" : state.workspaceView === "closed" ? "detail" : state.workspaceView, browserTabId: previewLocked(state) ? state.browserTabId : null, starting: null, panel: null, paletteOpen: false });
  } else store.set({ starting: null, panel: null, paletteOpen: false });
  remember(id);
  await syncSelected(id);
}

export function newTask(): void {
  store.set(state => ({ selectedId: null, task: null, activity: [], reviews: [], events: [], eventSeq: 0, liveText: "", detail: null, workspaceView: previewLocked(state) ? "preview" : "closed", browserTabId: previewLocked(state) ? state.browserTabId : null, starting: null, panel: null, paletteOpen: false }));
  remember(null);
}

export function openDetail(detail: AppState["detail"]): void {
  store.set(state => ({ detail, workspaceView: detail ? previewLocked(state) ? "preview" : "detail" : state.workspaceView === "detail" ? "closed" : state.workspaceView }));
}

export function showPreview(): void {
  store.set({ workspaceView: "preview", detail: null });
}

export function selectBrowserTab(tabId: string | null): void {
  if (tabId && previewLocked(store.get())) {
    notify("本机预览正在使用浏览器，完成后再切换网页", "info");
    return;
  }
  store.set({ workspaceView: "preview", browserTabId: tabId, detail: null });
}

export function showReview(): void {
  store.set(state => previewLocked(state) ? { detail: { kind: "info" } } : { workspaceView: "detail", detail: null });
}

export function showTerminal(): void {
  if (previewLocked(store.get())) {
    notify("浏览器正在使用预览，完成后再切换终端", "info");
    return;
  }
  store.set({ workspaceView: "terminal", detail: null });
}

export function closeWorkspace(): void {
  store.set(state => previewLocked(state) && state.workspaceView === "preview" ? state : { workspaceView: "closed", detail: null });
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
  store.set({ panel: { kind: "settings", section }, paletteOpen: false });
}

export function openAutomations(): void { store.set({ panel: { kind: "automations" }, paletteOpen: false }); }

export function closePanel(): void {
  store.set({ panel: null });
}

export function openPalette(): void { store.set({ paletteOpen: true }); }
export function closePalette(): void { store.set({ paletteOpen: false }); }

export async function updateTaskMeta(id: string, patch: TaskMeta): Promise<boolean> {
  try {
    const updated = await api.updateTaskMeta(id, patch);
    store.set(state => ({
      tasks: upsertSummary(state.tasks, updated),
      task: state.selectedId === id ? updated : state.task,
    }));
    return true;
  } catch (error) { notify(messageOf(error)); return false; }
}

export async function openProductFolder(id: string): Promise<void> {
  try {
    const task = await api.task(id);
    if (!task.projectRoot || !window.alpha?.openFolder) throw new Error("桌面端才能打开产品目录");
    const error = await window.alpha.openFolder(task.projectRoot);
    if (error) throw new Error(error);
  } catch (error) { notify(messageOf(error)); }
}

export async function openPreviewInBrowser(id: string): Promise<void> {
  try {
    const task = await api.task(id);
    if (!task.preview?.live) throw new Error("这个任务没有在线预览");
    if (!window.alpha?.openExternal || !await window.alpha.openExternal(task.preview.url)) throw new Error("无法在浏览器打开预览");
  } catch (error) { notify(messageOf(error)); }
}

export async function exportTaskReport(id: string): Promise<void> {
  try {
    const [task, activity, reviews, timeline] = await Promise.all([api.task(id), api.activity(id), api.reviews(id), api.taskEvents(id)]);
    const content = buildTaskReport(task, activity, reviews, timeline.events);
    const filename = `${taskTitle(task).replace(/[<>:"/\\|?*]/g, "_")}-报告.md`;
    if (window.alpha?.saveText) {
      if (await window.alpha.saveText(filename, content)) notify("报告已保存", "info");
      return;
    }
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch (error) { notify(messageOf(error)); }
}

export async function copyTaskId(id: string): Promise<void> {
  try { await navigator.clipboard.writeText(id); notify("任务 ID 已复制", "info"); }
  catch { notify("无法访问剪贴板"); }
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
let inFlightSettings: SettingsPatch = {};
let settingsFlight: Promise<boolean> | null = null;
let settingsRevision = 0;

function acceptSettings(settings: Settings): void {
  const revision = settings.revision ?? 0;
  if (revision < settingsRevision) return;
  settingsRevision = revision;
  store.set({ settings: applyPatch(settings, combinePatches(inFlightSettings, unsentSettings)) });
}

async function flushSettings(): Promise<boolean> {
  clearTimeout(settingsTimer);
  if (settingsFlight) {
    await settingsFlight;
    return flushSettings();
  }
  const patch = unsentSettings;
  unsentSettings = {};
  if (!Object.keys(patch).length) return true;
  inFlightSettings = patch;
  const flight = (async () => {
    try {
      acceptSettings(await api.updateSettings(patch));
      return true;
    } catch (error) {
      notify(messageOf(error));
      const current = await api.settings().catch(() => null);
      if (current) {
        inFlightSettings = {};
        acceptSettings(current);
      }
      return false;
    } finally {
      inFlightSettings = {};
    }
  })();
  settingsFlight = flight;
  try { return await flight; }
  finally { if (settingsFlight === flight) settingsFlight = null; }
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
  store.set({ workspaceView: "preview", browserTabId: null });
}

/** The visible preview stays open on the browser while the user controls it or a task verifies in it. */
export function previewLocked(state: AppState): boolean {
  return state.controlHolder === "user" || browserOwner(state) !== null;
}

const notifiedPhases = new Set<string>();
function notifyStatus(message: Extract<ServerMessage, { type: "status" }>): void {
  if (!message.taskId || !["已验收", "待验收", "失败", "用户接管", "已回答"].includes(message.phase)) return;
  const key = `${message.taskId}:${message.runId ?? ""}:${message.phase}`;
  if (notifiedPhases.has(key)) return;
  notifiedPhases.add(key);
  setTimeout(async () => {
    if (!store.get().settings?.notifications.enabled || document.hasFocus() || !window.alpha?.notify) return;
    const task = await api.task(message.taskId!).catch(() => null);
    if (!task || (message.phase === "待验收" && (task.running || task.status !== "active"))) {
      notifiedPhases.delete(key);
      return;
    }
    window.alpha.notify(`Alpha · ${taskTitle(task)}`, message.phase === "用户接管" ? "浏览器需要你接管" : message.phase === "已回答" ? "追问已回答" : `任务${message.phase}`, task.id);
    window.alpha.attention?.();
  }, message.phase === "待验收" ? 1_000 : 0);
}

function handleMessage(message: ServerMessage): void {
  const state = store.get();
  if (message.type === "task" || message.type === "operations" || message.type === "runs" || message.type === "status") tasksRequestVersion++;
  switch (message.type) {
    case "operations":
      store.set({ operations: message.operations });
      followBrowser(state);
      break;
    case "runs":
      store.set({ runs: message.runs });
      openStarted();
      break;
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
      if (task.id === state.selectedId) { selectedRequestVersion++; void refreshTaskEvents(task.id); }
      store.set(current => ({
        tasks: upsertSummary(current.tasks, task),
        task: current.selectedId === task.id ? task : current.task,
        runningPreview: current.runningPreview?.taskId === task.id && !task.preview?.live ? null : current.runningPreview,
      }));
      scheduleTasksRefresh();
      break;
    }
    case "settings":
      acceptSettings(message.settings);
      break;
    case "status": {
      notifyStatus(message);
      // Another task's verification reveals the browser through `operations`; its publication stays in the background.
      if (message.taskId === state.selectedId && (message.phase === "发布本机预览" || message.phase === "浏览器验收")) revealPreviewForBrowserWork();
      if (!TERMINAL_PHASES.has(message.phase)) break;
      if (!message.taskId && state.starting && !state.starting.error && message.runId && message.runId === state.starting.runId) {
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
      if (message.taskId === state.selectedId) revealPreviewForBrowserWork();
      if (message.taskId) {
        store.set({ runningPreview: { taskId: message.taskId, url: message.url } });
        if (message.taskId === state.selectedId) void syncSelected(message.taskId);
      }
      break;
    case "control":
      store.set({ controlHolder: message.holder });
      break;
    case "error":
      if (!message.taskId && state.starting && message.runId && message.runId === state.starting.runId) store.set({ starting: { ...state.starting, error: message.message } });
      break;
  }
}

async function loadSettings(): Promise<void> {
  const settings = await api.settings().catch(() => null);
  if (settings) acceptSettings(settings);
}

async function resync(): Promise<void> {
  await Promise.all([refreshTasks(), refreshProjects(), loadSettings()]);
  const id = store.get().selectedId;
  if (id) await syncSelected(id);
  const holder = await api.control().catch(() => null);
  if (holder) store.set({ controlHolder: holder });
}

export function startWorkbench(): () => void {
  const stopNotificationClick = window.alpha?.onOpenTask?.(id => { void openTask(id); });
  const stopWebTabRequest = window.alpha?.onWebTabRequested?.(({ taskId, tabId }) => {
    if (store.get().selectedId === taskId) selectBrowserTab(tabId);
    else if (!store.get().selectedId) void openTask(taskId).then(() => { if (store.get().selectedId === taskId) selectBrowserTab(tabId); });
    else notify("网页已在另一任务中打开，切换到该任务查看", "info");
  });
  const stopWebTabClosed = window.alpha?.onWebTabClosed?.(tabId => {
    if (store.get().browserTabId === tabId) store.set({ browserTabId: null });
  });
  const disconnect = connectEvents({
    onMessage: handleMessage,
    onState: connection => store.set({ connection }),
    onReconnect: () => {
      // Events may have been missed while disconnected; the server state is re-read instead.
      void resync();
    },
  });
  void (async () => {
    const [list] = await Promise.all([refreshTasks(), refreshProjects(), loadSettings()]);
    const saved = recalled();
    const id = list?.tasks.find(task => task.id === saved)?.id ?? list?.runs.find(run => run.taskId)?.taskId ?? list?.tasks[0]?.id;
    if (id && !store.get().selectedId) void openTask(id);
    const holder = await api.control().catch(() => null);
    if (holder) store.set({ controlHolder: holder });
  })();
  const poll = setInterval(() => {
    const state = store.get();
    if (state.runs.length || state.operations.length) void resync();
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
    stopNotificationClick?.();
    stopWebTabRequest?.();
    stopWebTabClosed?.();
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

export async function startTask(brief: string, model: string | null = null, expertId: string | null = null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false): Promise<void> {
  const text = brief.trim();
  if (!text || store.get().pending) return;
  store.set({ pending: "start", starting: { brief: text, error: null } });
  try {
    const { runId } = await api.start(text, model, expertId, startMode, continueUntilAccepted);
    store.set(state => ({ starting: state.starting && !state.starting.error ? { ...state.starting, runId } : state.starting }));
    openStarted();
  } catch (error) {
    store.set({ starting: { brief: text, error: messageOf(error) } });
  } finally {
    store.set({ pending: null });
  }
}

export async function startGeneralTask(input: Parameters<typeof api.startGeneral>[0]): Promise<void> {
  const text = input.objective.trim();
  if (!text || store.get().pending) return;
  store.set({ pending: "start", starting: { brief: text, error: null } });
  try {
    const { taskId } = await api.startGeneral(input);
    await Promise.all([refreshTasks(), openTask(taskId)]);
  } catch (error) { store.set({ starting: { brief: text, error: messageOf(error) } }); }
  finally { store.set({ pending: null }); }
}

export async function importTask(sourcePath: string, objective: string, model: string | null = null, expertId: string | null = null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false): Promise<void> {
  const text = objective.trim();
  if (!sourcePath.trim() || !text || store.get().pending) return;
  store.set({ pending: "start", starting: { brief: text, error: null } });
  try {
    const { taskId } = await api.importWorkspace(sourcePath.trim(), text, model, expertId, startMode, continueUntilAccepted);
    await Promise.all([refreshTasks(), openTask(taskId)]);
  } catch (error) {
    store.set({ starting: { brief: text, error: messageOf(error) } });
  } finally { store.set({ pending: null }); }
}

export async function startProjectTask(projectId: string, mountId: string, objective: string, permissionMode: import("../api/types").PermissionMode, model: string | null = null, expertId: string | null = null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false): Promise<void> {
  const text = objective.trim();
  if (!projectId || !mountId || !text || store.get().pending) return;
  store.set({ pending: "start", starting: { brief: text, error: null } });
  try {
    const { taskId } = await api.startProjectTask(projectId, mountId, text, permissionMode, model, expertId, startMode, continueUntilAccepted);
    await Promise.all([refreshTasks(), openTask(taskId)]);
  } catch (error) {
    store.set({ starting: { brief: text, error: messageOf(error) } });
  } finally { store.set({ pending: null }); }
}

export async function startWorkflow(taskType: "research" | "file-work", objective: string, files: File[], model: string | null = null, startMode: "plan" | "execute" = "execute", continueUntilAccepted = false): Promise<void> {
  const text = objective.trim();
  if (!text || store.get().pending) return;
  store.set({ pending: "start", starting: { brief: text, error: null } });
  try {
    const { taskId } = await api.startWorkflow(taskType, text, files, model, startMode, continueUntilAccepted);
    await Promise.all([refreshTasks(), openTask(taskId)]);
  } catch (error) {
    store.set({ starting: { brief: text, error: messageOf(error) } });
  } finally { store.set({ pending: null }); }
}

export function clearStarting(): void {
  store.set({ starting: null });
}

async function afterLaunch(taskId: string): Promise<void> {
  await Promise.all([refreshTasks(), syncSelected(taskId)]);
}

export async function resumeTask(instruction: string, taskId?: string): Promise<boolean> {
  const task = taskId ? (store.get().task?.id === taskId ? store.get().task : await api.task(taskId)) : store.get().task;
  if (!task) return false;
  const result = await perform("resume", () => api.resume(task.id, instruction.trim()));
  if (!result) return false;
  await afterLaunch(task.id);
  return true;
}

export async function enterPlanning(): Promise<boolean> {
  const task = store.get().task;
  if (!task) return false;
  const result = await perform("plan", () => api.enterPlan(task.id));
  if (!result) return false;
  await afterLaunch(task.id);
  return true;
}

export async function approveTaskPlan(): Promise<boolean> {
  const task = store.get().task;
  if (!task?.cognition || task.phase !== "plan-review" || !task.revision) return false;
  const result = await perform("approve", () => api.approvePlan(task.id, { contractVersion: task.contractVersion, cognitionRevision: task.cognition!.revision, sourceRevision: task.revision! }));
  if (!result) return false;
  await afterLaunch(task.id);
  return true;
}

export async function setGoalContinuation(enabled: boolean): Promise<boolean> {
  const task = store.get().task;
  if (!task) return false;
  const result = await perform("goal", () => api.setGoal(task.id, enabled));
  if (!result) return false;
  await syncSelected(task.id);
  return true;
}

export async function reviseTask(objective: string): Promise<boolean> {
  const task = store.get().task;
  const text = objective.trim();
  if (!task || !text || text === task.objective) return false;
  const result = await perform("revise", () => api.revise(task.id, text));
  if (!result) return false;
  await afterLaunch(task.id);
  return true;
}

export async function sendTaskMessage(input: Parameters<typeof api.sendMessage>[1]): Promise<boolean> {
  const task = store.get().task;
  if (!task) return false;
  const result = await perform(task.running ? "guidance" : task.status === "complete" ? "revise" : "resume", () => api.sendMessage(task.id, input));
  if (!result) return false;
  if (result.runId) await afterLaunch(task.id);
  else await syncSelected(task.id);
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

/** Asks a question about the selected task; the answer reads its workspace and never changes the task. */
export async function askTask(question: string): Promise<boolean> {
  const task = store.get().task;
  const text = question.trim();
  if (!task || !text) return false;
  const result = await perform("ask", () => api.ask(task.id, text));
  if (!result) return false;
  await afterLaunch(task.id);
  return true;
}

/** Stops the work in progress on a task (the selected one by default): its model run, or a cancellable operation. */
export async function stopTask(taskId: string | null = store.get().selectedId): Promise<void> {
  if (!taskId || stopping.has(taskId)) return;
  const state = store.get();
  const run = runOf(state, taskId);
  const operation = operationOf(state, taskId);
  if (!run && !operation?.cancellable) return;
  stopping.add(taskId);
  try {
    if (run) await api.cancel(run.runId);
    else await api.cancelOperation(operation!.id);
    notify("正在停止本轮运行…", "info");
  } catch (error) { notify(messageOf(error)); }
  finally { stopping.delete(taskId); }
}

const stopping = new Set<string>();

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
  if (controlFlight) return controlFlight;
  const holder: ControlHolder = store.get().controlHolder === "alpha" ? "user" : "alpha";
  controlFlight = (async () => {
    try {
      await api.setControl(holder);
      store.set({ controlHolder: holder });
      const state = store.get();
      const task = state.task;
      if (holder === "alpha" && task?.status === "active" && task.preview?.live && task.pending.includes("user-path") && !isOccupied(state, task.id)) void verifyTask();
    } catch (error) { notify(messageOf(error)); }
    finally { controlFlight = null; }
  })();
  return controlFlight;
}

let controlFlight: Promise<void> | null = null;
