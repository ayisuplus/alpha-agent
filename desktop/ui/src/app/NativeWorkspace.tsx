/**
 * 右栏：项目审查、原生终端、浏览器面板、文件、诊断日志（默认隐藏）。
 * 浏览器沿用 desktop/preload.cjs 的截屏流与接管/交还契约。
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ClipboardCheck, FolderOpen, Globe2, PanelRightClose, Terminal } from "lucide-react";
import type { BrowserHostStatus, BrowserTabInfo } from "../api/types";
import type { SessionController } from "./useSession";
import { nativeApi, sessionRequest, toolPayload } from "./native-api";
import { NativeTerminal } from "./NativeTerminal";
import { NativeFiles } from "./NativeFiles";
import { diffFiles } from "./workbench-state";

/** 截屏画面自适应样式：样式表没有对应图片规则，其余复用现有类。 */
const FRAME_STYLE: CSSProperties = { maxWidth: "100%", maxHeight: "100%", border: "1px solid var(--border)", background: "white" };

export type WorkspaceTab = "review" | "terminal" | "browser" | "files" | "logs";

type ProjectReview = { available: boolean; status: string; staged: string; unstaged: string; truncated: boolean; reason?: string };

function ReviewPanel({ session, onOpenFile }: { session: SessionController; onOpenFile(path: string): void }) {
  const [review, setReview] = useState<ProjectReview | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setReview(null); setError("");
    if (!session.selected) return;
    let cancelled = false;
    void sessionRequest<ProjectReview>(session.selected, "review").then(value => { if (!cancelled) setReview(value); }, cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [session.selected, session.messages.length, refresh]);
  if (!session.current) return <div className="native-panel"><p className="native-muted">选择会话后，可以审查项目改动和会话产物。</p></div>;
  const artifacts = session.messages.filter(message => message.role === "toolResult").flatMap(message => toolPayload(message)?.artifacts ?? []);
  return <div className="native-panel">
    <h3>任务审查</h3><p>{session.current.title}</p><p className="native-muted">{session.current.cwd}</p>
    {session.tianshuStatus && <p className="native-muted">天枢：{session.tianshuStatus}</p>}
    <h4>项目改动 <button onClick={() => setRefresh(value => value + 1)}>刷新改动</button></h4>
    <p className="native-muted">当前项目整体 Git 改动；未跟踪文件只列路径。</p>
    {error ? <p role="alert">{error}</p> : !review ? <p className="native-muted">正在读取…</p> : !review.available ? <p className="native-muted">{review.reason}</p> : <>
      <pre className="native-review-output">{review.status || "工作区没有改动。"}</pre>
      {[{ title: "已暂存", diff: review.staged }, { title: "未暂存", diff: review.unstaged }].filter(section => section.diff).map(section => <section key={section.title}>
        <h4>{section.title}</h4>{diffFiles(section.diff).map((file, index) => <details className="native-diff-file" key={`${file.path}:${index}`}>
          <summary><span title={file.path}>{file.path}</span><span className="tone-text-success">+{file.added}</span><span className="tone-text-danger">−{file.removed}</span></summary>
          <button className="native-file-link" onClick={() => onOpenFile(file.path)}>预览当前文件</button>
          <pre className="native-diff-lines">{file.lines.map((line, number) => <span key={number} className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : ""}>{line || " "}{"\n"}</span>)}</pre>
        </details>)}<details><summary>原始差异</summary><pre className="native-review-output">{section.diff}</pre></details>
      </section>)}
      {review.truncated && <p className="native-muted">改动内容较大，当前显示已截断。</p>}
    </>}
    <h4>会话产物</h4>
    {artifacts.length ? artifacts.map((artifact, index) => <div className="native-file" key={`${artifact.path}:${index}`}><button title={artifact.path} onClick={() => onOpenFile(artifact.path)}>{artifact.path.split(/[\\/]/).at(-1)}</button><small>{artifact.kind}</small></div>) : <p className="native-muted">还没有工具回传的产物。</p>}
  </div>;
}

function TerminalPanel({ session }: { session: SessionController }) {
  if (!session.selected) return <div className="native-panel"><p className="native-muted">选择或创建会话后，可打开该会话的 Alpha 终端。</p></div>;
  return <div className="native-terminal-panel">
    <div className="native-panel"><h3>Alpha 终端</h3><p className="native-muted">使用当前原生会话；打开期间对话由终端接管。收起右栏不会停止终端。</p>
      {session.terminalActive ? <button onClick={() => void session.terminal("stop")}>关闭 Alpha 终端</button>
        : <button disabled={session.busy || !session.state?.isSettled || session.state.hasPendingAsyncWork} onClick={() => void session.terminal("start")}>打开 Alpha 终端</button>}
    </div>
    {session.terminalActive ? <NativeTerminal id={session.selected} output={session.terminalOutput} onError={session.setError} />
      : <div className="native-panel"><h4>运行日志</h4>{session.logs.length ? session.logs.map((log, index) => <p className="native-log" key={index}><time>{log.at}</time> {log.text}</p>) : <p className="native-muted">还没有运行事件。</p>}</div>}
  </div>;
}

function BrowserPanel({ visible }: { visible: boolean }) {
  const [host, setHost] = useState<BrowserHostStatus | null>(null);
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [frameError, setFrameError] = useState("");
  const [taken, setTaken] = useState(false);
  const [note, setNote] = useState("");
  const slot = useRef<HTMLDivElement>(null);
  const takenRef = useRef(false);
  takenRef.current = taken;

  useEffect(() => {
    const bridge = window.alpha;
    if (!bridge?.browserHostStatus) { setHost({ available: false, port: null, reason: "需要 Alpha 桌面版" }); return; }
    void bridge.browserHostStatus().then(setHost, () => setHost({ available: false, port: null, reason: "无法读取浏览器宿主状态" }));
    const off = bridge.onBrowserHostStatusChanged?.(status => setHost(status));
    return () => off?.();
  }, []);

  useEffect(() => {
    if (!visible || !host?.available) { setTabs([]); return; }
    let cancelled = false;
    const load = async () => {
      const result = await window.alpha?.browserTabs?.();
      if (cancelled || !result) return;
      if (!result.available) { setTabs([]); return; }
      setTabs(result.tabs);
      setTarget(current => current && result.tabs.some(tab => tab.targetId === current) ? current : result.tabs[0]?.targetId ?? null);
    };
    void load().catch(() => undefined);
    const timer = setInterval(() => void load().catch(() => undefined), 4_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [visible, host?.available]);

  // 换标签即重订阅截屏流：停旧目标、开新目标。
  useEffect(() => {
    const bridge = window.alpha;
    const screencast = bridge?.browserScreencast;
    if (!visible || !target || !screencast) return;
    let cancelled = false;
    setFrame(null);
    setFrameError("");
    const off = bridge?.onBrowserScreencastFrame?.(frame => {
      if (frame.targetId !== target) return;
      if (frame.data) { setFrame(`data:image/jpeg;base64,${frame.data}`); setFrameError(""); }
      else setFrameError(frame.error ?? "页面画面已结束");
    });
    void screencast({ action: "start", targetId: target, maxDimension: 1280 }).then(result => {
      if (!result.ok && !cancelled) setFrameError(result.error ?? "无法订阅页面画面");
    }, () => undefined);
    return () => {
      cancelled = true;
      off?.();
      void screencast({ action: "stop", targetId: target }).catch(() => undefined);
    };
  }, [visible, target]);

  // 关闭面板或退出时交还窗口。
  useEffect(() => () => {
    if (takenRef.current) void window.alpha?.browserHandback?.().then(result => { if (result.ok) void nativeApi("browser-control", { paused: false }); }).catch(() => undefined);
  }, []);

  const takeover = async () => {
    const rect = slot.current?.getBoundingClientRect();
    if (!rect) return;
    try {
    await nativeApi("browser-control", { paused: true });
    const live = await nativeApi<{ sessions: Array<{ status?: string }> }>("sessions");
    if (live.sessions.some(item => item.status === "工作中" || item.status === "等待输入")) {
      await nativeApi("browser-control", { paused: false });
      setNote("请先停止或等待工作中的会话完成，再接管共享浏览器。"); return;
    }
    const result = await window.alpha?.browserTakeover?.({
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ...(target ? { targetId: target } : {}),
    });
    if (result?.ok) { setTaken(true); setNote(""); }
    else { await nativeApi("browser-control", { paused: false }); setNote(result?.error ?? "无法接管浏览器窗口"); }
    } catch (cause) { await nativeApi("browser-control", { paused: false }).catch(() => undefined); setNote(String(cause)); }
  };
  const handback = async () => {
    const result = await window.alpha?.browserHandback?.();
    if (result?.ok) { await nativeApi("browser-control", { paused: false }); setTaken(false); setNote(""); }
    else setNote(result?.error ?? "无法交还浏览器窗口");
  };

  const restartHost = async () => {
    setNote("正在重启浏览器宿主…");
    const result = await window.alpha?.browserHostRestart?.().catch(() => ({ ok: false, reason: "重启失败" }));
    setNote(result?.ok ? "浏览器宿主已重启。" : result?.reason ?? "需要 Alpha 桌面版");
  };

  return <div className="native-browser">
    <p className="native-muted">共享浏览器 · 所有会话共用标签页与登录状态；接管期间暂停新的浏览器与代码求值调用。</p>
    <div className="native-browser-tabs">
      {tabs.map(tab => <button key={tab.targetId} className={target === tab.targetId ? "active" : ""} onClick={() => setTarget(tab.targetId)} title={`${tab.title}\n${tab.url}`}>{tab.title || tab.url || "页面"}</button>)}
      {host?.available && (taken
        ? <button onClick={() => void handback()} style={{ marginLeft: "auto" }}>交还</button>
        : <button onClick={() => void takeover()} disabled={!target} style={{ marginLeft: "auto" }}>接管</button>)}
    </div>
    <div className="native-browser-slot" ref={slot}>
      {!host ? <p className="native-muted">正在连接浏览器宿主…</p>
        : !host.available ? <div className="native-muted">
          <p>{window.alpha ? `浏览器宿主不可用${host.reason ? `（${host.reason}）` : ""}。` : "网页预览不提供桌面浏览器宿主，请在 Alpha 桌面版查看和接管网页。"}</p>
          {window.alpha?.browserHostRestart && <button onClick={() => void restartHost()}>重启浏览器宿主</button>}
        </div>
        : !target ? <p className="native-muted">智能体打开网页后，这里实时显示页面画面（只读）。“接管”后可登录、过验证码，“交还”后智能体继续使用同一登录状态。</p>
        : frame ? <img alt="页面实时画面" src={frame} style={FRAME_STYLE} />
        : <p className="native-muted">{frameError || "正在等待页面画面…"}</p>}
    </div>
    {note && <p className="native-muted">{note}</p>}
  </div>;
}

export function NativeWorkspace({ session, diagnostics, tab, setTab, onClose, previewPath, onPreviewPath, onOpenFile, onResize }: { session: SessionController; diagnostics: boolean; tab: WorkspaceTab; setTab(tab: WorkspaceTab): void; onClose(): void; previewPath: string | null; onPreviewPath(path: string | null): void; onOpenFile(path: string): void; onResize(width: number): void }) {
  useEffect(() => { if (!diagnostics && tab === "logs") setTab("browser"); }, [diagnostics, tab]);
  const tabs: Array<{ id: WorkspaceTab; label: string; Icon: typeof Globe2 }> = [
    { id: "review", label: "审查", Icon: ClipboardCheck },
    { id: "terminal", label: "终端", Icon: Terminal },
    { id: "browser", label: "浏览器", Icon: Globe2 },
    { id: "files", label: "文件", Icon: FolderOpen },
    ...(diagnostics ? [{ id: "logs" as const, label: "日志", Icon: Terminal }] : []),
  ];
  return <aside id="native-workspace" aria-label="右侧工作区" className={`native-workspace ${tab === "browser" ? "browser-open" : ""}`}>
    <div className="native-workspace-resizer" role="separator" aria-label="调整右栏宽度" aria-orientation="vertical" tabIndex={0}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onResize((event.currentTarget.parentElement?.getBoundingClientRect().width ?? 380) + (event.key === "ArrowLeft" ? 24 : -24)); } }}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onResize(window.innerWidth - 56 - event.clientX); }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
    <div className="native-tabs" role="tablist" aria-label="工作区视图">
      {tabs.map(({ id, label, Icon }) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={15} /> {label}</button>)}
      <button className="native-workspace-close" aria-label="收起右侧栏" title="收起右侧栏" onClick={onClose}><PanelRightClose size={17} /></button>
    </div>
    {tab === "review" && <ReviewPanel session={session} onOpenFile={onOpenFile} />}
    {tab === "terminal" && <TerminalPanel session={session} />}
    {tab === "browser" && <BrowserPanel visible />}
    <NativeFiles key={session.selected} session={session} visible={tab === "files"} previewPath={previewPath} onPreviewPath={onPreviewPath} />
    {tab === "logs" && <div className="native-panel">
      <h3>运行日志</h3>
      {session.logs.length ? session.logs.map((log, index) => <p className="native-log" key={index}><time>{log.at}</time> {log.text}</p>) : <p className="native-muted">还没有运行事件。</p>}
    </div>}
  </aside>;
}
