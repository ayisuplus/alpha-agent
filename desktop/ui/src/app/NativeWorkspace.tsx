/**
 * 右栏（方案 8.2）：浏览器面板（按 desktop/preload.cjs 契约：标签列表 + 截屏流 JPEG 只读画面 +
 * 接管/交还；宿主不可用显示“当前为不可见模式”；换标签后重订阅截屏流）、文件、诊断日志（默认隐藏）。
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FileText, FolderOpen, Globe2, Terminal } from "lucide-react";
import type { BrowserHostStatus, BrowserTabInfo } from "../api/types";
import type { SessionController } from "./useSession";

/** 截屏画面自适应样式：样式表没有对应图片规则，其余复用现有类。 */
const FRAME_STYLE: CSSProperties = { maxWidth: "100%", maxHeight: "100%", border: "1px solid var(--border)", background: "white" };

type WorkspaceTab = "browser" | "files" | "logs";

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
    if (takenRef.current) void window.alpha?.browserHandback?.().catch(() => undefined);
  }, []);

  const takeover = async () => {
    const rect = slot.current?.getBoundingClientRect();
    if (!rect) return;
    const result = await window.alpha?.browserTakeover?.({
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ...(target ? { targetId: target } : {}),
    });
    if (result?.ok) { setTaken(true); setNote(""); }
    else setNote(result?.error ?? "无法接管浏览器窗口");
  };
  const handback = async () => {
    const result = await window.alpha?.browserHandback?.();
    if (result?.ok) { setTaken(false); setNote(""); }
    else setNote(result?.error ?? "无法交还浏览器窗口");
  };

  return <div className="native-browser">
    <div className="native-browser-tabs">
      {tabs.map(tab => <button key={tab.targetId} className={target === tab.targetId ? "active" : ""} onClick={() => setTarget(tab.targetId)} title={`${tab.title}\n${tab.url}`}>{tab.title || tab.url || "页面"}</button>)}
      {host?.available && (taken
        ? <button onClick={() => void handback()} style={{ marginLeft: "auto" }}>交还</button>
        : <button onClick={() => void takeover()} disabled={!target} style={{ marginLeft: "auto" }}>接管</button>)}
    </div>
    <div className="native-browser-slot" ref={slot}>
      {!host ? <p className="native-muted">正在连接浏览器宿主…</p>
        : !host.available ? <p className="native-muted">当前为不可见模式{host.reason ? `（${host.reason}）` : ""}。智能体的无头浏览器照常工作。</p>
        : !target ? <p className="native-muted">智能体打开网页后，这里实时显示页面画面（只读）。“接管”后可登录、过验证码，“交还”后智能体继续使用同一登录状态。</p>
        : frame ? <img alt="页面实时画面" src={frame} style={FRAME_STYLE} />
        : <p className="native-muted">{frameError || "正在等待页面画面…"}</p>}
    </div>
    {note && <p className="native-muted">{note}</p>}
  </div>;
}

export function NativeWorkspace({ session, diagnostics }: { session: SessionController; diagnostics: boolean }) {
  const [tab, setTab] = useState<WorkspaceTab>(() => {
    const saved = localStorage.getItem("alpha-native-workspace-tab");
    return saved === "files" || saved === "logs" || saved === "browser" ? saved : "browser";
  });
  useEffect(() => { localStorage.setItem("alpha-native-workspace-tab", tab); }, [tab]);
  useEffect(() => { if (!diagnostics && tab === "logs") setTab("browser"); }, [diagnostics, tab]);
  const tabs: Array<{ id: WorkspaceTab; label: string; Icon: typeof Globe2 }> = [
    { id: "browser", label: "浏览器", Icon: Globe2 },
    { id: "files", label: "文件", Icon: FolderOpen },
    ...(diagnostics ? [{ id: "logs" as const, label: "日志", Icon: Terminal }] : []),
  ];
  return <aside className={`native-workspace ${tab === "browser" ? "browser-open" : ""}`}>
    <div className="native-tabs">
      {tabs.map(({ id, label, Icon }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={15} /> {label}</button>)}
    </div>
    {tab === "browser" && <BrowserPanel visible />}
    {tab === "files" && <div className="native-panel">
      <h3>项目文件</h3>
      <p className="native-muted">{session.current?.cwd ?? "未选择项目"}</p>
      {session.files.map(file => <div className="native-file" key={file.name}>
        <FileText size={14} /><span>{file.name}</span>
        <small>{file.type === "directory" ? "目录" : file.size ? `${Math.round(file.size / 1024)} KB` : "文件"}</small>
      </div>)}
    </div>}
    {tab === "logs" && <div className="native-panel">
      <h3>运行日志</h3>
      {session.logs.length ? session.logs.map((log, index) => <p className="native-log" key={index}><time>{log.at}</time> {log.text}</p>) : <p className="native-muted">还没有运行事件。</p>}
    </div>}
  </aside>;
}
