/**
 * 会话生命周期与消息流（方案 8.2 的 useSession）：
 * 选中会话 → `POST /open` 拉起 OMP 进程 → 订阅 events SSE → 读取 state/messages/models/files。
 * 进程被回收（`host_exit`）时提示并允许重新 /open。
 */

import { desktopStorage } from "./desktop-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  NativeApiError,
  openSession,
  request,
  sessionEventsUrl,
  sessionRequest,
  type LegacyTask,
  type NativeMessage,
  type NativeState,
  type SessionItem,
  type UiRequest,
} from "./native-api";
import { readDraft, writeDraft } from "./workbench-state";
import { desktopCommand, invokeDesktopCommand } from "./desktop-commands";

export interface LogEntry { at: string; text: string }
export interface PendingCall { toolCallId: string; toolName: string; args: unknown; startedAt: number }
export interface WidgetBlock { key: string; lines: string[] }
export interface AttachedImage { data: string; mimeType: string; name: string }
export const nativeImages = (images: AttachedImage | AttachedImage[]) => (Array.isArray(images) ? images : [images]).map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }));

export interface SessionController {
  sessions: SessionItem[];
  legacy: LegacyTask[];
  selected: string | null;
  current: SessionItem | null;
  opened: boolean;
  /** 进程停止或打不开时的提示（host_exit / 409），非空即显示“重新打开会话”。 */
  hostNotice: string | null;
  reopen(): void;
  select(id: string | null): void;
  create(cwd?: string): Promise<boolean>;
  continueLegacy(task: LegacyTask): Promise<boolean>;
  startFromHome(input: { text: string; cwd: string; model: string; thinking: string; image?: AttachedImage | AttachedImage[] }): Promise<boolean>;
  state: NativeState | null;
  messages: NativeMessage[];
  liveMessage: NativeMessage | null;
  /** 旧版任务“继续”带回来的续写草稿；Composer 拾取后调用 consumeDraft 清除。 */
  queuedDraft: string;
  consumeDraft(): void;
  prefill(text: string): void;
  models: Array<{ provider: string; id: string; name?: string }>;
  files: Array<{ name: string; type: string; size?: number }>;
  pendingCalls: PendingCall[];
  /** toolCallId → 耗时（毫秒），来自 tool_execution_start/end 事件。 */
  toolTiming: Record<string, number>;
  /** 自动压缩/自动重试的进行中一行说明（消息流落库后由持久记录接管）。 */
  liveNotes: Array<{ id: string; text: string }>;
  widgets: WidgetBlock[];
  tianshuStatus: string | null;
  logs: LogEntry[];
  uiRequest: UiRequest | null;
  uiValue: string;
  setUiValue(value: string): void;
  respond(confirmed?: boolean): Promise<void>;
  externalUrl: string;
  setExternalUrl(value: string): void;
  terminalActive: boolean;
  terminalOutput: string;
  terminal(action: "start" | "stop"): Promise<void>;
  command(value: Record<string, unknown>): Promise<boolean>;
  send(text: string, image?: AttachedImage | AttachedImage[], mode?: "steer" | "follow_up"): Promise<boolean>;
  refresh(): void;
  reloadList(): Promise<void>;
  busy: boolean;
  error: string;
  setError(value: string): void;
  planRevision: number;
}

const REFRESH_EVENTS = ["message_end", "prompt_result", "session_settled", "agent_end", "model_changed", "session_tree"];
const LOG_EVENTS = ["subagent_lifecycle", "subagent_progress", "host_error", "auto_retry_end", "auto_compaction_end"];

export function reconcileLiveMessage(live: NativeMessage | null, history: NativeMessage[], completed = false): NativeMessage | null {
  return live?.timestamp !== undefined && history.some(message => message.role === "assistant" && message.timestamp === live.timestamp && (completed || JSON.stringify(message.content) === JSON.stringify(live.content))) ? null : live;
}

export function useSession(): SessionController {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [legacy, setLegacy] = useState<LegacyTask[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [hostNotice, setHostNotice] = useState<string | null>(null);
  const [state, setState] = useState<NativeState | null>(null);
  const [messages, setMessages] = useState<NativeMessage[]>([]);
  const [liveMessage, setLiveMessage] = useState<NativeMessage | null>(null);
  const [models, setModels] = useState<Array<{ provider: string; id: string; name?: string }>>([]);
  const [files, setFiles] = useState<Array<{ name: string; type: string; size?: number }>>([]);
  const [pendingCalls, setPendingCalls] = useState<PendingCall[]>([]);
  const [toolTiming, setToolTiming] = useState<Record<string, number>>({});
  const [liveNotes, setLiveNotes] = useState<Array<{ id: string; text: string }>>([]);
  const [widgets, setWidgets] = useState<WidgetBlock[]>([]);
  const [tianshuStatus, setTianshuStatus] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [uiRequest, setUiRequest] = useState<UiRequest | null>(null);
  const [uiValue, setUiValue] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [terminalActive, setTerminalActive] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [queuedDraft, setQueuedDraft] = useState("");
  const [openNonce, setOpenNonce] = useState(0);
  const [planRevision, setPlanRevision] = useState(0);
  const planStop = useRef(false);

  const selectedRef = useRef<string | null>(null);
  const hostStopped = useRef(true);
  const loadRevision = useRef(0);
  const restoreSelection = useRef(true);
  const toolStarts = useRef<Map<string, number>>(new Map());
  const completedLive = useRef<NativeMessage | null>(null);
  const statuses = useRef(new Map<string, string | undefined>());
  const sending = useRef(false);
  const responding = useRef(false);
  const startupError = useRef<{ id: string; message: string } | null>(null);
  const requestRef = useRef(uiRequest);
  requestRef.current = uiRequest;
  selectedRef.current = selected;

  const reloadList = useCallback(async () => {
    const [live, old] = await Promise.all([
      request<{ sessions: SessionItem[] }>("/api/native/sessions"),
      request<{ tasks: LegacyTask[] }>("/api/native/legacy"),
    ]);
    setSessions(live.sessions);
    if (restoreSelection.current) {
      restoreSelection.current = false;
      const remembered = desktopStorage.getItem("alpha-last-session");
      if (remembered && live.sessions.some(item => item.id === remembered)) setSelected(remembered);
    }
    for (const item of live.sessions) {
      const before = statuses.current.get(item.id);
      if (before && before !== item.status && ["完成", "失败", "等待输入"].includes(item.status ?? "")) {
        window.alpha?.notify?.(`Alpha · ${item.status}`, `${item.title}${item.notice ? `：${item.notice}` : ""}`, item.id);
        if (item.status === "等待输入") window.alpha?.attention?.();
      }
      statuses.current.set(item.id, item.status);
    }
    setLegacy(old.tasks);
  }, []);

  const loadSelected = useCallback(async (id: string) => {
    if (hostStopped.current) return;
    const revision = loadRevision.current;
    try {
      const terminal = await sessionRequest<{ active: boolean; output: string }>(id, "terminal");
      if (selectedRef.current !== id || revision !== loadRevision.current || hostStopped.current) return;
      setTerminalActive(terminal.active);
      setTerminalOutput(terminal.output);
      if (terminal.active) return;
      // 契约：state/messages/models 要求进程已打开（POST /open 之后才读）。
      const completed = completedLive.current;
      const [nextState, history, available, directory] = await Promise.all([
        sessionRequest<NativeState>(id, "state"),
        sessionRequest<{ messages: NativeMessage[] }>(id, "messages"),
        sessionRequest<{ models: Array<{ provider: string; id: string; name?: string }> }>(id, "models"),
        sessionRequest<{ files: Array<{ name: string; type: string; size?: number }> }>(id, "files"),
      ]);
      if (selectedRef.current !== id || revision !== loadRevision.current || hostStopped.current) return;
      setState(nextState);
      setOpened(true); setHostNotice(null);
      setMessages(history.messages ?? []);
      setLiveMessage(current => reconcileLiveMessage(current, history.messages ?? [], current === completed));
      setModels(available.models ?? []);
      setFiles(directory.files ?? []);
      setPendingCalls(current => {
        const settled = new Set((history.messages ?? []).map(message => message.toolCallId).filter(Boolean));
        return current.filter(call => !settled.has(call.toolCallId));
      });
    } catch (cause) {
      if (selectedRef.current === id && revision === loadRevision.current && !hostStopped.current) throw cause;
    }
  }, []);

  useEffect(() => {
    void reloadList().catch(cause => setError(String(cause)));
    const timer = setInterval(() => void reloadList().catch(() => undefined), 3_000);
    return () => clearInterval(timer);
  }, [reloadList]);

  useEffect(() => {
    hostStopped.current = true;
    loadRevision.current++;
    if (!selected) {
      setState(null); setMessages([]); setModels([]); setFiles([]); setLogs([]); setWidgets([]);
      setPendingCalls([]); setToolTiming({}); setLiveNotes([]); setTianshuStatus(null);
      setTerminalActive(false); setTerminalOutput(""); setOpened(false); setHostNotice(null);
      return;
    }
    let cancelled = false;
    let feed: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(null); setMessages([]); setLogs([]); setWidgets([]); setPendingCalls([]); setToolTiming({});
    setLiveMessage(null);
    completedLive.current = null;
    setLiveNotes([]); setTianshuStatus(null); setOpened(false); setHostNotice(null);
    setError(startupError.current?.id === selected ? startupError.current.message : "");
    startupError.current = null;
    const refresh = () => {
      if (hostStopped.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => void loadSelected(selected).catch(cause => { if (!cancelled) setError(String(cause)); }), 180);
    };
    void (async () => {
      try {
        const terminal = await sessionRequest<{ active: boolean }>(selected, "terminal");
        if (!terminal.active) await openSession(selected);
        if (cancelled) return;
        hostStopped.current = false;
        setOpened(true);
        void reloadList().catch(() => undefined);
        feed = new EventSource(await sessionEventsUrl(selected));
        const disconnected = "与 Alpha 本机服务的事件连接已断开，正在重连。";
        feed.onopen = () => setError(current => current === disconnected ? "" : current);
        feed.onmessage = event => {
          const frame = JSON.parse(event.data) as Record<string, unknown>;
          const type = String(frame.type ?? "");
          if (type === "alpha_plan") { setPlanRevision(value => value + 1); refresh(); }
          if (type === "alpha_plan_stop") planStop.current = frame.interrupting === true;
          if (type === "message_update") {
            const partial = (frame.assistantMessageEvent as { partial?: NativeMessage } | undefined)?.partial ?? frame.message as NativeMessage | undefined;
            if (partial?.role === "assistant") { completedLive.current = null; setLiveMessage(partial); }
          }
          // Keep the final row until get_messages replaces it, so settling cannot shrink the reading viewport.
          if (type === "message_end" && (frame.message as NativeMessage | undefined)?.role === "assistant") { completedLive.current = frame.message as NativeMessage; setLiveMessage(completedLive.current); }
          if (type === "agent_start") setState(current => current ? { ...current, isStreaming: true, isSettled: false } : current);
          if (type === "prompt_result") {
            if (frame.status === "error") setError((frame.error as { message?: string } | undefined)?.message ?? "本轮执行失败");
            if (frame.status === "aborted") {
              setLiveNotes(current => [...current.filter(note => note.id !== "result"), { id: "result", text: planStop.current ? "计划已提交审阅，等待你的选择。" : "本轮已中止" }]);
              planStop.current = false;
            }
          }
          if (type === "command_output") setLiveNotes(current => [...current.filter(note => note.id !== "command"), { id: "command", text: String(frame.text ?? "") }]);
          const at = new Date().toLocaleTimeString();
          if (type === "terminal_start") { hostStopped.current = true; loadRevision.current++; clearTimeout(timer); setTerminalActive(true); }
          if (type === "terminal_chunk") setTerminalOutput(current => (current + String(frame.chunk ?? "")).slice(-100_000));
          if (type === "terminal_exit") { setTerminalActive(false); refresh(); }
          if (type === "terminal_error") setError(String(frame.error ?? "Alpha 终端启动失败"));
          if (type === "extension_ui_request") handleUiFrame(frame, {
            onDialog(request) { setUiValue(request.prefill ?? ""); setUiRequest(request); },
            onCancel(targetId) { setUiRequest(current => current && (!targetId || current.id === targetId) ? null : current); },
            onUrl(value) { setExternalUrl(value); },
            onNotify(message) { setLogs(items => [...items.slice(-149), { at, text: message }]); setLiveNotes(current => [...current.filter(note => note.id !== "notification"), { id: "notification", text: message }]); },
            onStatus(key, text) { if (key === "tianshu") setTianshuStatus(text ?? null); },
            onWidget(key, lines) {
              setWidgets(current => {
                const rest = current.filter(block => block.key !== key);
                return lines === undefined ? rest : [...rest, { key, lines }];
              });
            },
            onTitle(title) {
              setSessions(current => current.map(item => item.id === selectedRef.current ? { ...item, title } : item));
            },
          });
          if (type === "tool_execution_start") {
            const call: PendingCall = { toolCallId: String(frame.toolCallId ?? ""), toolName: String(frame.toolName ?? "工具"), args: frame.args ?? frame.arguments, startedAt: Date.now() };
            toolStarts.current.set(call.toolCallId, call.startedAt);
            if (call.toolCallId) setPendingCalls(current => [...current.filter(item => item.toolCallId !== call.toolCallId), call]);
          }
          if (type === "tool_execution_end") {
            const id = String(frame.toolCallId ?? "");
            const started = toolStarts.current.get(id);
            toolStarts.current.delete(id);
            if (started !== undefined) setToolTiming(current => ({ ...current, [id]: Date.now() - started }));
            setPendingCalls(current => current.filter(call => call.toolCallId !== id));
            setLogs(items => [...items.slice(-149), { at, text: `${frame.toolName ?? "工具"} ${frame.isError ? "失败" : "完成"}` }]);
          }
          if (type === "auto_compaction_start") setLiveNotes(current => [...current.filter(note => note.id !== "compact"), { id: "compact", text: "自动压缩上下文（进行中）…" }]);
          if (type === "auto_compaction_end") setLiveNotes(current => current.filter(note => note.id !== "compact"));
          if (type === "auto_retry_start") setLiveNotes(current => [...current.filter(note => note.id !== "retry"), { id: "retry", text: `自动重试（第 ${Number(frame.attempt ?? 1)} 次）…` }]);
          if (type === "auto_retry_end") setLiveNotes(current => current.filter(note => note.id !== "retry"));
          if (type === "host_exit") {
            hostStopped.current = true;
            loadRevision.current++;
            clearTimeout(timer);
            setOpened(false);
            setHostNotice(frame.restarting ? null : String(frame.error ?? "Alpha 已停止这个会话的进程。"));
            setUiRequest(null);
          }
          if (type === "host_ready") {
            hostStopped.current = false;
            loadRevision.current++;
            setOpened(true); setHostNotice(null);
            refresh();
          }
          if (type === "host_error") setLogs(items => [...items.slice(-149), { at, text: `host_error: ${String(frame.error ?? "")}` }]);
          if (REFRESH_EVENTS.includes(type)) refresh();
          if (LOG_EVENTS.includes(type)) setLogs(items => [...items.slice(-149), { at, text: `${type}: ${String(frame.toolName ?? frame.payload ?? "")}` }]);
        };
        feed.onerror = () => setError(disconnected);
        await loadSelected(selected);
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof NativeApiError && cause.status === 409 ? "会话进程未打开" : String(cause);
        setHostNotice(message);
        setOpened(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      feed?.close();
    };
  }, [selected, openNonce, loadSelected, reloadList]);

  useEffect(() => { void reloadList().catch(() => undefined); }, [messages.length, reloadList]);

  const select = useCallback((id: string | null) => {
    restoreSelection.current = false;
    setSelected(id);
    try { if (id) desktopStorage.setItem("alpha-last-session", id); else desktopStorage.removeItem("alpha-last-session"); } catch (cause) { setError(String(cause)); }
    setUiRequest(null);
  }, []);

  const reopen = useCallback(() => setOpenNonce(current => current + 1), []);

  const create = useCallback(async (cwd?: string) => {
    setBusy(true); setError("");
    try {
      const result = await request<{ session: SessionItem }>("/api/native/sessions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cwd || undefined }),
      });
      await reloadList();
      select(result.session.id);
      return true;
    } catch (cause) { setError(String(cause)); return false; }
    finally { setBusy(false); }
  }, [reloadList, select]);

  const continueLegacy = useCallback(async (task: LegacyTask) => {
    setBusy(true); setError("");
    try {
      const result = await request<{ session: SessionItem; draft: string }>(`/api/native/legacy/${encodeURIComponent(task.id)}/continue`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      await reloadList();
      setQueuedDraft(result.draft ?? "");
      select(result.session.id);
      return true;
    } catch (cause) { setError(String(cause)); return false; }
    finally { setBusy(false); }
  }, [reloadList, select]);

  const startFromHome = useCallback(async (input: { text: string; cwd: string; model: string; thinking: string; image?: AttachedImage | AttachedImage[] }) => {
    const text = input.text.trim();
    if (!text || !input.model || sending.current) return false;
    sending.current = true;
    setBusy(true); setError("");
    let created: string | null = null;
    try {
      const result = await request<{ session: SessionItem }>("/api/native/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: input.cwd.trim() || undefined, title: text.slice(0, 70) }),
      });
      created = result.session.id;
      const [provider, ...modelId] = input.model.split("/");
      await openSession(result.session.id);
      await sessionRequest(result.session.id, "command", { type: "set_model", provider, modelId: modelId.join("/") });
      if (input.thinking !== "auto") await sessionRequest(result.session.id, "command", { type: "set_thinking_level", level: input.thinking });
      await reloadList();
      const plan = desktopCommand(text);
      if (plan?.id === "plan") await sessionRequest(result.session.id, "host/plan", { action: "resume" });
      const message = plan?.id === "plan" ? plan.args : text;
      if (message) await sessionRequest(result.session.id, "command", { type: "prompt", message, ...(input.image ? { images: nativeImages(input.image) } : {}) });
      select(result.session.id);
      return true;
    } catch (cause) {
      if (created) {
        startupError.current = { id: created, message: String(cause) };
        writeDraft(created, readDraft("home", desktopStorage), desktopStorage);
        select(created);
      }
      setError(String(cause)); return false;
    }
    finally { sending.current = false; setBusy(false); }
  }, [reloadList, select]);

  const command = useCallback(async (value: Record<string, unknown>) => {
    const id = selectedRef.current;
    if (!id) return false;
    setError("");
    try {
      await sessionRequest(id, "command", value);
      void loadSelected(id).catch(() => undefined);
      return true;
    } catch (cause) { setError(String(cause)); return false; }
  }, [loadSelected]);

  const send = useCallback(async (text: string, image?: AttachedImage | AttachedImage[], mode?: "steer" | "follow_up") => {
    const message = text.trim() || (image ? "请分析这张图片。" : "");
    if (!message || !selectedRef.current || sending.current) return false;
    sending.current = true;
    const images = image ? nativeImages(image) : undefined;
    try {
      const local = desktopCommand(message);
      if (local) return await invokeDesktopCommand(local.id, local.args, image);
      return await command({ type: mode === "follow_up" ? "follow_up" : state?.isStreaming ? "steer" : "prompt", message, ...(images ? { images } : {}) });
    }
    finally { sending.current = false; }
  }, [command, state?.isStreaming]);

  const terminal = useCallback(async (action: "start" | "stop") => {
    const id = selectedRef.current;
    if (!id) return;
    try {
      if (action === "start") setTerminalOutput("");
      await sessionRequest(id, `terminal/${action}`, action === "start" ? { cols: 100, rows: 30 } : {});
      if (action === "start") setTerminalActive(true);
    } catch (cause) { setError(String(cause)); }
  }, []);

  const respond = useCallback(async (confirmed?: boolean) => {
    const id = selectedRef.current;
    if (!id || !uiRequest || requestRef.current?.id !== uiRequest.id || responding.current) return;
    responding.current = true;
    const response = confirmed === false ? { type: "extension_ui_response", id: uiRequest.id, cancelled: true }
      : uiRequest.method === "confirm" ? { type: "extension_ui_response", id: uiRequest.id, confirmed: true }
      : { type: "extension_ui_response", id: uiRequest.id, value: uiValue };
    try {
      await sessionRequest(id, "ui-response", response);
      setUiRequest(current => current?.id === uiRequest.id ? null : current);
    } catch (cause) { setError(String(cause)); }
    finally { responding.current = false; }
  }, [uiRequest, uiValue]);

  const refresh = useCallback(() => {
    const id = selectedRef.current;
    if (id) void loadSelected(id).catch(cause => setError(String(cause)));
  }, [loadSelected]);

  return {
    sessions, legacy, selected, current: sessions.find(item => item.id === selected) ?? null,
    opened, hostNotice, reopen, select, create, continueLegacy, startFromHome,
    state, messages, liveMessage, queuedDraft, consumeDraft: () => setQueuedDraft(""), prefill: setQueuedDraft,
    models, files, pendingCalls, toolTiming, liveNotes, widgets, tianshuStatus, logs,
    uiRequest, uiValue, setUiValue, respond, externalUrl, setExternalUrl,
    terminalActive, terminalOutput, terminal, command, send, refresh, reloadList,
    busy, error, setError, planRevision,
  };
}

/** extension_ui_request 帧分流：对话框 / 对话框取消 / 打开链接 / 通知 / 状态段 / 部件字符串行 / 标题。 */
export function handleUiFrame(frame: Record<string, unknown>, sinks: {
  onDialog(request: UiRequest): void;
  onCancel(targetId?: string): void;
  onUrl(value: string): void;
  onNotify(message: string): void;
  onStatus(key: string, text: string | undefined): void;
  onWidget(key: string, lines: string[] | undefined): void;
  onTitle(title: string): void;
}): void {
  const method = String(frame.method ?? "");
  if (["select", "confirm", "input", "editor"].includes(method)) {
    sinks.onDialog(frame as unknown as UiRequest);
    return;
  }
  // 中止（如用户停止本轮）时内核会取消挂起的对话框；不清理会留下点了没反应的弹窗。
  if (method === "cancel") { sinks.onCancel(typeof frame.targetId === "string" ? frame.targetId : undefined); return; }
  if (method === "open_url") sinks.onUrl(String(frame.launchUrl ?? frame.url ?? ""));
  else if (method === "notify") sinks.onNotify(String(frame.message ?? "Alpha 通知"));
  else if (method === "setStatus") sinks.onStatus(String(frame.statusKey ?? ""), typeof frame.statusText === "string" ? frame.statusText : undefined);
  else if (method === "setWidget") sinks.onWidget(String(frame.widgetKey ?? ""), Array.isArray(frame.widgetLines) ? frame.widgetLines.map(String) : undefined);
  else if (method === "setTitle" && typeof frame.title === "string" && frame.title.trim()) sinks.onTitle(frame.title.trim().slice(0, 120));
}
