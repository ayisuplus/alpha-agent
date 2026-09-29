import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, BrainCircuit, CircleStop, FileText, FolderOpen, Globe2, Plus, RotateCcw, Terminal } from "lucide-react";
import { NativeTerminal } from "./NativeTerminal";
import "./NativeApp.css";

type Session = { id: string; cwd: string; title: string; createdAt: string; updatedAt: string; legacyTaskId?: string };
type Legacy = { id: string; title: string; status: string; objective: string };
type Message = { role: string; content: string | Array<{ type: string; text?: string; name?: string; arguments?: unknown }>; toolName?: string; isError?: boolean; customType?: string; timestamp?: number };
type State = { model?: { provider: string; id: string; name?: string }; thinkingLevel?: string; isStreaming: boolean; isSettled: boolean; hasPendingAsyncWork: boolean; sessionName?: string; contextUsage?: { tokens: number; contextWindow: number; percent?: number } };
type Cognition = { mode: string; frame: { turn: number; quality: Record<string, string>; facts: Record<string, unknown>; signals: Array<{ key: string; summary: string; evidenceKey: string }> } };
type UiRequest = { id: string; method: string; title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; url?: string; launchUrl?: string };
type UpdateStatus = { current: string; latest: string | null; checkedAt: string | null; available: boolean; notifiedVersion: string | null; error: string | null };

async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, data === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
}
const pathFor = (id: string, action: string) => `/api/native/sessions/${id}/${action}`;
function plain(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
}
function messageLabel(message: Message): string {
  if (message.role === "toolResult") return message.toolName ?? "工具";
  if (message.role === "custom") return message.customType ?? "扩展";
  return message.role === "user" ? "你" : "OMP";
}
function safeExternalUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"); }
  catch { return false; }
}

export function NativeApp() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [legacy, setLegacy] = useState<Legacy[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<Array<{ provider: string; id: string; name?: string }>>([]);
  const [cognition, setCognition] = useState<Cognition | null>(null);
  const [logs, setLogs] = useState<Array<{ at: string; text: string }>>([]);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<Array<{ name: string; type: string; size?: number }>>([]);
  const [activeTab, setActiveTab] = useState<"cognition" | "files" | "browser" | "logs">("cognition");
  const [browserTabs, setBrowserTabs] = useState<Array<{ taskId: string; tabId: string }>>([]);
  const [browserTab, setBrowserTab] = useState<string | null>(null);
  const browserSlot = useRef<HTMLDivElement>(null);
  const [uiRequest, setUiRequest] = useState<UiRequest | null>(null);
  const [externalUrl, setExternalUrl] = useState("");
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [uiValue, setUiValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<{ data: string; mimeType: string; name: string } | null>(null);
  const [terminalActive, setTerminalActive] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  const alertedVersion = useRef<string | null>(null);
  selectedRef.current = selected;

  useEffect(() => {
    const refresh = () => { void api<UpdateStatus>("/api/native/updates").then(setUpdate, cause => setError(String(cause))); };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!update?.available || !update.latest || update.notifiedVersion === update.latest || alertedVersion.current === update.latest || !window.alpha?.notify) return;
    alertedVersion.current = update.latest;
    window.alpha.notify("OMP 内核有更新", `可用版本 ${update.latest}，当前 ${update.current}。打开 Alpha 查看，升级由你决定。`, "omp-update");
    window.alpha.attention?.();
    void api<UpdateStatus>("/api/native/updates/notified", { version: update.latest }).then(setUpdate, cause => setError(String(cause)));
  }, [update]);

  const loadList = useCallback(async () => {
    const [native, old] = await Promise.all([api<{ sessions: Session[] }>("/api/native/sessions"), api<{ tasks: Legacy[] }>("/api/native/legacy")]);
    setSessions(native.sessions);
    setLegacy(old.tasks);
  }, []);
  useEffect(() => { void loadList().catch(cause => setError(String(cause))); }, [loadList]);
  const loadSelected = useCallback(async (id: string) => {
    const terminal = await api<{ active: boolean; output: string }>(pathFor(id, "terminal"));
    if (selectedRef.current !== id) return;
    setTerminalActive(terminal.active);
    setTerminalOutput(terminal.output);
    if (terminal.active) return;
    const [nextState, history, currentCognition, available, directory] = await Promise.all([
      api<State>(pathFor(id, "state")), api<{ messages: Message[] }>(pathFor(id, "messages")),
      api<Cognition | null>(pathFor(id, "cognition")), api<{ models: typeof models }>(pathFor(id, "models")),
      api<{ files: typeof files }>(pathFor(id, "files")),
    ]);
    if (selectedRef.current !== id) return;
    setState(nextState);
    setMessages(history.messages ?? []);
    setCognition(currentCognition);
    setModels(available.models ?? []);
    setFiles(directory.files ?? []);
  }, []);
  useEffect(() => {
    if (!selected) { setState(null); setMessages([]); setCognition(null); setLogs([]); return; }
    setError("");
    void loadSelected(selected).catch(cause => setError(String(cause)));
    const feed = new EventSource(pathFor(selected, "events"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void loadSelected(selected).catch(cause => setError(String(cause))), 180); };
    feed.onmessage = event => {
      const frame = JSON.parse(event.data) as Record<string, unknown>;
      const at = new Date().toLocaleTimeString();
      if (frame.type === "terminal_start") setTerminalActive(true);
      if (frame.type === "terminal_chunk") setTerminalOutput(current => (current + String(frame.chunk ?? "")).slice(-100_000));
      if (frame.type === "terminal_exit") { setTerminalActive(false); refresh(); }
      if (frame.type === "terminal_error") setError(String(frame.error ?? "Native terminal failed"));
      if (frame.type === "extension_ui_request") {
        const request = frame as unknown as UiRequest;
        if (["select", "confirm", "input", "editor"].includes(request.method)) { setUiValue(request.prefill ?? ""); setUiRequest(request); }
        else if (request.method === "open_url") { setExternalUrl(request.launchUrl ?? request.url ?? ""); }
        else if (request.method === "notify") setLogs(items => [...items.slice(-149), { at, text: String(frame.message ?? "OMP 通知") }]);
      }
      if (["message_end", "prompt_result", "session_settled", "agent_end", "model_changed", "host_exit"].includes(String(frame.type))) refresh();
      if (["tool_execution_start", "tool_execution_end", "auto_retry_start", "auto_compaction_start", "auto_compaction_end", "subagent_lifecycle", "host_error", "host_exit"].includes(String(frame.type))) {
        setLogs(items => [...items.slice(-149), { at, text: `${frame.type}: ${String(frame.toolName ?? frame.error ?? frame.payload?.toString?.() ?? "")}` }]);
      }
    };
    feed.onerror = () => setError("OMP 事件连接已断开，正在重连。 ");
    return () => { if (timer) clearTimeout(timer); feed.close(); };
  }, [selected, loadSelected]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, selected]);
  useEffect(() => {
    const opened = window.alpha?.onWebTabRequested?.(request => {
      setBrowserTabs(items => items.some(item => item.tabId === request.tabId) ? items : [...items, request]);
      if (selectedRef.current === request.taskId) { setBrowserTab(request.tabId); setActiveTab("browser"); }
    });
    const closed = window.alpha?.onWebTabClosed?.(tabId => {
      setBrowserTabs(items => items.filter(item => item.tabId !== tabId));
      setBrowserTab(current => current === tabId ? null : current);
    });
    return () => { opened?.(); closed?.(); };
  }, []);
  useEffect(() => {
    const slot = browserSlot.current;
    const visible = activeTab === "browser" && browserTabs.some(item => item.taskId === selected && item.tabId === browserTab);
    if (!slot || !visible || !browserTab) { window.alpha?.setWebBounds?.(null, { x: 0, y: 0, width: 0, height: 0, visible: false }); return; }
    const update = () => { const rect = slot.getBoundingClientRect(); window.alpha?.setWebBounds?.(browserTab, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: true }); };
    const observer = new ResizeObserver(update);
    observer.observe(slot);
    update();
    return () => { observer.disconnect(); window.alpha?.setWebBounds?.(browserTab, { x: 0, y: 0, width: 0, height: 0, visible: false }); };
  }, [activeTab, browserTab, browserTabs, selected]);

  const current = useMemo(() => sessions.find(item => item.id === selected), [sessions, selected]);
  async function create(cwd?: string): Promise<void> {
    setBusy(true); setError("");
    try {
      const result = await api<{ session: Session }>("/api/native/sessions", { cwd: cwd || current?.cwd });
      await loadList(); setSelected(result.session.id); setDraft(""); setProjectDialog(false);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function continueLegacy(task: Legacy): Promise<void> {
    setBusy(true); setError("");
    try {
      const result = await api<{ session: Session; draft: string }>(`/api/native/legacy/${task.id}/continue`, {});
      await loadList(); setSelected(result.session.id); setDraft(result.draft);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function command(value: Record<string, unknown>): Promise<boolean> {
    if (!selected) return false;
    setError("");
    try { await api(pathFor(selected, "command"), value); void loadSelected(selected); return true; }
    catch (cause) { setError(String(cause)); return false; }
  }
  async function terminal(action: "start" | "stop"): Promise<void> {
    if (!selected) return;
    try {
      await api(pathFor(selected, `terminal/${action}`), action === "start" ? { cols: 100, rows: 30 } : {});
      if (action === "start") { setTerminalOutput(""); setTerminalActive(true); }
    } catch (cause) { setError(String(cause)); }
  }
  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || !selected) return;
    const images = image ? [{ type: "image", data: image.data, mimeType: image.mimeType }] : undefined;
    if (await command({ type: state?.isStreaming ? "steer" : "prompt", message: text, ...(images ? { images } : {}) })) { setDraft(""); setImage(null); }
  }
  async function attachImage(file?: File): Promise<void> {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 4_000_000) { setError("请选择不超过 4 MB 的图片。"); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    setImage({ data: dataUrl.split(",")[1], mimeType: file.type, name: file.name });
  }
  async function respond(confirmed?: boolean): Promise<void> {
    if (!selected || !uiRequest) return;
    const response = confirmed === false ? { type: "extension_ui_response", id: uiRequest.id, cancelled: true }
      : uiRequest.method === "confirm" ? { type: "extension_ui_response", id: uiRequest.id, confirmed: true }
      : { type: "extension_ui_response", id: uiRequest.id, value: uiValue };
    try { await api(pathFor(selected, "ui-response"), response); setUiRequest(null); }
    catch (cause) { setError(String(cause)); }
  }

  return <div className="native-workbench">
    <aside className="native-sidebar">
      <div className="native-brand"><span className="native-mark">α</span><span><strong>Alpha</strong><small>OMP · 天枢认知</small></span></div>
      <button className="native-new" onClick={() => void create()} disabled={busy}><Plus size={16} /> 新会话</button>
      <button className="native-project-choice" onClick={() => { setProjectPath(""); setProjectDialog(true); }}>在其他目录开始</button>
      <div className="native-list-title">原生会话</div>
      <div className="native-session-list">{sessions.map(item => <button key={item.id} className={`native-session ${selected === item.id ? "active" : ""}`} onClick={() => setSelected(item.id)} title={item.cwd}><span>{item.title}</span><small>{item.cwd}</small></button>)}</div>
      <div className="native-list-title">旧任务 · 只读</div>
      <div className="native-session-list native-legacy">{legacy.map(item => <div className="native-old" key={item.id}><span title={item.objective}>{item.title}</span><button onClick={() => void continueLegacy(item)} disabled={busy}>用 OMP 继续</button></div>)}</div>
      <div className="native-version">OMP {update?.current ?? "18.4.3"} <span>·</span> Tianshu v3.27.0 {update?.error && <button title={update.error} onClick={() => void api<UpdateStatus>("/api/native/updates/check", {}).then(setUpdate, cause => setError(String(cause)))}>检测失败 · 重试</button>}</div>
    </aside>
    <main className="native-main">
      {update?.available && update.latest && <div className="native-update-banner" role="status"><strong>OMP {update.latest} 已发布</strong><span>当前 {update.current}。请告诉我“更新 Alpha 的 OMP”，我会先核对变更；不会自动替你升级。</span><button onClick={() => { const url = "https://github.com/can1357/oh-my-pi/releases"; if (window.alpha?.openExternal) void window.alpha.openExternal(url); else window.open(url, "_blank"); }}>发布说明</button></div>}
      {current ? <>
        <header className="native-header"><div><strong>{current.title}</strong><small>{current.cwd}</small></div><div className="native-header-actions">
          <span className={`native-status ${state?.isStreaming ? "running" : ""}`}>{state?.isStreaming ? "运行中" : state?.hasPendingAsyncWork ? "后台任务" : state?.isSettled ? "本轮结束" : "就绪"}</span>
          <button title="刷新" onClick={() => void loadSelected(current.id)}><RotateCcw size={16} /></button>
          {terminalActive ? <button title="关闭原生终端" onClick={() => void terminal("stop")}><CircleStop size={17} /></button> : <button title="切换到 OMP 原生终端" disabled={!state?.isSettled || state?.hasPendingAsyncWork} onClick={() => void terminal("start")}><Terminal size={17} /></button>}
          {state?.isStreaming && <button title="停止" onClick={() => void command({ type: "abort" })}><CircleStop size={17} /></button>}
        </div></header>
        {terminalActive ? <NativeTerminal id={current.id} output={terminalOutput} /> : <>
        <div className="native-thread">{messages.length ? messages.filter(message => message.role !== "custom").map((message, index) => <article key={`${index}-${message.timestamp ?? 0}`} className={`native-message ${message.role}`}><div className="native-role">{messageLabel(message)}</div>{message.role === "toolResult" ? <details><summary>{message.isError ? "执行失败" : "查看结果"}</summary><pre>{plain(message)}</pre></details> : <div className="native-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{plain(message)}</ReactMarkdown>{Array.isArray(message.content) && message.content.filter(part => part.type === "toolCall").map((part, i) => <div className="native-tool-call" key={i}>调用 {part.name}</div>)}</div>}</article>) : <div className="native-welcome"><div className="native-glyph">α</div><h1>从这里开始</h1><p>告诉 OMP 你想完成什么。天枢会根据实际证据提供认知建议。</p></div>}<div ref={end} /></div>
        <div className="native-compose"><div className="native-compose-tools"><label title="添加图片"><FileText size={16} /><input type="file" accept="image/*" onChange={event => void attachImage(event.target.files?.[0])} /></label>{image && <span>{image.name} <button onClick={() => setImage(null)}>×</button></span>}
          <select title="模型" value={state?.model ? `${state.model.provider}/${state.model.id}` : ""} onChange={event => { const [provider, ...rest] = event.target.value.split("/"); void command({ type: "set_model", provider, modelId: rest.join("/") }); }}><option value="">选择模型</option>{models.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? model.id} · {model.provider}</option>)}</select>
          <button onClick={() => void command({ type: "compact" })} title="原生上下文压缩">压缩上下文</button>
        </div><textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={state?.isStreaming ? "补充要求，将作为 steer 送入 OMP…" : "向 OMP 说明你的任务…"} /><div className="native-compose-bottom"><span>{state?.model ? `${state.model.provider}/${state.model.id}` : "OMP 原生模型配置"}</span><button disabled={!draft.trim()} onClick={() => void send()} aria-label="发送"><ArrowUp size={17} /></button></div></div></>}
      </> : <div className="native-empty"><div className="native-glyph">α</div><h1>Alpha</h1><p>原生 OMP，天枢认知增强。</p><button className="native-new" onClick={() => void create()}><Plus size={16} /> 新会话</button></div>}
    </main>
    <aside className={`native-workspace ${activeTab === "browser" ? "browser-open" : ""}`}><div className="native-tabs"><button className={activeTab === "cognition" ? "active" : ""} onClick={() => setActiveTab("cognition")}><BrainCircuit size={15} /> 认知</button><button className={activeTab === "files" ? "active" : ""} onClick={() => setActiveTab("files")}><FolderOpen size={15} /> 文件</button><button className={activeTab === "browser" ? "active" : ""} onClick={() => setActiveTab("browser")}><Globe2 size={15} /> 浏览器</button><button className={activeTab === "logs" ? "active" : ""} onClick={() => setActiveTab("logs")}><Terminal size={15} /> 日志</button></div>
      {activeTab === "cognition" && <div className="native-panel"><h3>当前认知</h3>{cognition ? <><p className="native-muted">模式 {cognition.mode} · 第 {cognition.frame.turn} 轮</p>{cognition.frame.signals.length ? cognition.frame.signals.map(signal => <div className="native-signal" key={signal.key}><strong>{signal.summary}</strong><small>证据 {signal.evidenceKey}</small></div>) : <p className="native-muted">暂无需要反馈的信号</p>}<h4>证据质量</h4>{Object.entries(cognition.frame.quality).map(([name, quality]) => <div className="native-fact" key={name}><span>{name}</span><em>{quality}</em></div>)}</> : <p className="native-muted">选择并启动会话后显示认知快照。</p>}</div>}
      {activeTab === "files" && <div className="native-panel"><h3>项目文件</h3><p className="native-muted">{current?.cwd ?? "未选择项目"}</p>{files.map(file => <div className="native-file" key={file.name}><FileText size={14} /><span>{file.name}</span><small>{file.type === "directory" ? "目录" : file.size ? `${Math.round(file.size / 1024)} KB` : "文件"}</small></div>)}</div>}
      {activeTab === "browser" && <div className="native-browser"><div className="native-browser-tabs">{browserTabs.filter(item => item.taskId === selected).map((item, index) => <button key={item.tabId} className={browserTab === item.tabId ? "active" : ""} onClick={() => setBrowserTab(item.tabId)}>网页 {index + 1}</button>)}</div><div className="native-browser-slot" ref={browserSlot}>{!browserTab && <p className="native-muted">让 OMP 打开网页后，页面会显示在这里。</p>}</div></div>}
      {activeTab === "logs" && <div className="native-panel"><h3>运行日志</h3>{logs.length ? logs.map((log, i) => <p className="native-log" key={i}><time>{log.at}</time> {log.text}</p>) : <p className="native-muted">还没有运行事件。</p>}</div>}
    </aside>
    {error && <div className="native-error" role="alert">{error}<button onClick={() => setError("")}>关闭</button></div>}
    {projectDialog && <div className="native-modal-backdrop"><div className="native-modal" role="dialog" aria-modal="true"><h2>在其他目录开始</h2><p>输入本机已有的项目目录，OMP 将直接在其中工作。</p><input className="native-path-input" autoFocus value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="例如 E:\\projects\\my-project" /><div><button onClick={() => setProjectDialog(false)}>取消</button><button className="native-primary" disabled={!projectPath.trim() || busy} onClick={() => void create(projectPath.trim())}>创建会话</button></div></div></div>}
    {externalUrl && <div className="native-modal-backdrop"><div className="native-modal" role="dialog" aria-modal="true"><h2>OMP 请求打开网页</h2><p className="native-muted">{externalUrl}</p><div><button onClick={() => setExternalUrl("")}>稍后</button><button className="native-primary" onClick={() => { const url = externalUrl; if (!safeExternalUrl(url)) { setError("OMP 提供的链接协议不受支持。"); return; } if (window.alpha?.openExternal) void window.alpha.openExternal(url).then(opened => { if (!opened) setError("无法打开此链接；请复制链接手动访问。"); }); else window.open(url, "_blank"); setExternalUrl(""); }}>在系统浏览器打开</button></div></div></div>}
    {uiRequest && <div className="native-modal-backdrop"><div className="native-modal" role="dialog" aria-modal="true"><h2>{uiRequest.title ?? "OMP 需要输入"}</h2>{uiRequest.message && <p>{uiRequest.message}</p>}{uiRequest.method === "select" ? <select value={uiValue} onChange={event => setUiValue(event.target.value)}><option value="">请选择</option>{uiRequest.options?.map(option => <option key={option}>{option}</option>)}</select> : uiRequest.method !== "confirm" ? <textarea value={uiValue} placeholder={uiRequest.placeholder} onChange={event => setUiValue(event.target.value)} /> : null}<div><button onClick={() => void respond(false)}>取消</button><button className="native-primary" onClick={() => void respond(true)}>确认</button></div></div></div>}
  </div>;
}
