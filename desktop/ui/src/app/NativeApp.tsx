/**
 * 桌面工作台外壳（方案 8.2）：拆分为 Sidebar / Home / Thread / Workspace / Dialogs 与 useSession。
 * Alpha 工作台：按需展开工作区，保留原生会话与配置契约。
 */

import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, FolderOpen, Globe2, PanelRightClose, Terminal, X } from "lucide-react";
import { loadConfiguration, request, type NativeCatalog, type NativeConfig, type UpdateStatus } from "./native-api";
import { NativeDialogs } from "./NativeDialogs";
import { NativeHome } from "./NativeHome";
import { NativeSettings } from "./NativeSettings";
import { NativeSidebar } from "./NativeSidebar";
import { NativeThread, absoluteArtifactPath } from "./NativeThread";
import { NativeWorkspace, type WorkspaceTab } from "./NativeWorkspace";
import { useSession } from "./useSession";
import "./NativeApp.css";
import { errorHelp, readDraft } from "./workbench-state";

export function NativeApp() {
  const session = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("model");
  const openSettings = (section = "model") => { setSettingsSection(section); setSettingsOpen(true); };
  const [projectPath, setProjectPath] = useState(() => readDraft("home", localStorage).cwd ?? "");
  const [config, setConfig] = useState<NativeConfig | null>(null);
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem("alpha-native-font-size")) || 15);
  const [theme, setTheme] = useState(() => localStorage.getItem("alpha-theme") ?? "light");
  const [workspaceWidth, setWorkspaceWidth] = useState(() => Math.max(320, Math.min(Number(localStorage.getItem("alpha-workspace-width")) || 400, 560)));
  const [preview, setPreview] = useState<{ id: string; path: string } | null>(null);
  const previewPath = preview?.id === session.selected ? preview.path : null;
  const setPreviewPath = (path: string | null) => setPreview(path && session.selected ? { id: session.selected, path } : null);
  const [workspaceVisible, setWorkspaceVisible] = useState(false);
  const workspaceTrigger = useRef<HTMLElement | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(() => {
    const saved = localStorage.getItem("alpha-native-workspace-tab");
    return saved === "review" || saved === "terminal" || saved === "files" || saved === "logs" ? saved : "browser";
  });
  const openWorkspace = (tab: WorkspaceTab) => {
    if (!workspaceVisible) workspaceTrigger.current = document.activeElement as HTMLElement;
    setWorkspaceTab(tab); setWorkspaceVisible(true); setSettingsOpen(false);
  };
  const closeWorkspace = () => { setWorkspaceVisible(false); requestAnimationFrame(() => {
    if (workspaceTrigger.current?.isConnected) workspaceTrigger.current.focus();
    else document.querySelector<HTMLButtonElement>('.native-workspace-actions button')?.focus();
  }); };
  const openFile = (path: string) => { setPreviewPath(absoluteArtifactPath(path, session.current?.cwd)); openWorkspace("files"); };
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 760 || localStorage.getItem("alpha-native-sidebar-collapsed") === "true");
  const [diagnostics, setDiagnostics] = useState(() => localStorage.getItem("alpha-native-diagnostics") === "1");
  const [error, setError] = useState("");
  const alertedVersion = useRef<string | null>(null);
  const selectSession = (id: string | null) => { session.select(id); setSettingsOpen(false); if (window.innerWidth < 760) setSidebarCollapsed(true); };

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 760px)');
    const collapse = () => { if (narrow.matches) setSidebarCollapsed(true); };
    narrow.addEventListener('change', collapse);
    return () => narrow.removeEventListener('change', collapse);
  }, []);

  useEffect(() => window.alpha?.onOpenTask?.(id => {
    if (id === "omp-update") { setSettingsSection("about"); setSettingsOpen(true); }
    else { session.select(id); setSettingsOpen(false); }
  }), [session.select]);

  useEffect(() => {
    void loadConfiguration().then(loaded => { setConfig(loaded.config); setCatalog(loaded.catalog); }).catch(cause => setError(String(cause)));
  }, []);
  useEffect(() => { localStorage.setItem("alpha-native-font-size", String(fontSize)); }, [fontSize]);
  useEffect(() => { localStorage.setItem("alpha-theme", theme); document.documentElement.dataset.alphaTheme = theme; }, [theme]);
  useEffect(() => { localStorage.setItem("alpha-workspace-width", String(workspaceWidth)); }, [workspaceWidth]);
  useEffect(() => { localStorage.setItem("alpha-native-workspace-tab", workspaceTab); }, [workspaceTab]);
  useEffect(() => { localStorage.setItem("alpha-native-sidebar-collapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem("alpha-native-diagnostics", diagnostics ? "1" : "0"); }, [diagnostics]);

  useEffect(() => {
    void request<UpdateStatus>("/api/native/updates").then(setUpdate, cause => setError(String(cause)));
  }, []);
  useEffect(() => {
    // 组件更新与产品发行版本分开；详细来源在关于页。
    if (!update?.available || !update.latest || update.dismissedVersion === update.latest || update.notifiedVersion === update.latest || alertedVersion.current === update.latest || !window.alpha?.notify) return;
    alertedVersion.current = update.latest;
    window.alpha.notify("Alpha · 运行组件有更新", "可在关于页查看组件版本与升级说明。", "omp-update");
    window.alpha.attention?.();
    void request<UpdateStatus>("/api/native/updates/notified", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: update.latest }) }).then(setUpdate, cause => setError(String(cause)));
  }, [update]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettingsOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); selectSession(null); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); openWorkspace("files"); }
      if (event.key === "Escape") {
        const menu = document.querySelector<HTMLDetailsElement>('.native-more[open]');
        if (menu) { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); }
        else if (settingsOpen) setSettingsOpen(false);
        else if (workspaceVisible) closeWorkspace();
        else if (window.innerWidth < 760) setSidebarCollapsed(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [settingsOpen, workspaceVisible]);

  const displayError = session.error || error;
  const showWorkspace = workspaceVisible && !settingsOpen;
  const workspaceActions = <nav className="native-workspace-actions" aria-label="工作区入口">
    {showWorkspace ? <button onClick={closeWorkspace} aria-label="收起工作区" title="收起工作区" aria-controls="native-workspace" aria-expanded><PanelRightClose size={18} /></button>
      : [{ id: "files" as const, label: "文件", Icon: FolderOpen }, { id: "browser" as const, label: "浏览器", Icon: Globe2 }, { id: "review" as const, label: "审查", Icon: ClipboardCheck }, { id: "terminal" as const, label: "终端", Icon: Terminal }].map(({ id, label, Icon }) =>
        <button key={id} onClick={() => openWorkspace(id)} aria-label={`打开${label}栏`} title={label} aria-controls="native-workspace" aria-expanded={false}><Icon size={17} /><span>{label}</span></button>)}
  </nav>;
  const help = errorHelp(displayError);
  return <div className={`native-workbench ${!showWorkspace ? "native-wide" : ""} ${sidebarCollapsed ? "native-sidebar-collapsed" : ""}`} style={{ "--native-message-size": `${fontSize}px`, "--ui-font-size": `${fontSize}px`, "--native-workspace-width": `${workspaceWidth}px` } as React.CSSProperties}>
    <NativeSidebar
      collapsed={sidebarCollapsed}
      onToggle={() => setSidebarCollapsed(value => !value)}
      sessions={session.sessions}
      legacy={session.legacy}
      selected={session.selected}
      busy={session.busy}
      onSelect={selectSession}
      onNew={() => selectSession(null)}
      onContinueLegacy={task => void session.continueLegacy(task)}
      onOpenSettings={openSettings}
    />
    <main className="native-main">
      {update?.available && update.latest && update.dismissedVersion !== update.latest && <div className="native-update-banner" role="status">
        <strong>运行组件有更新</strong>
        <span>查看版本与升级说明。</span>
        <button onClick={() => openSettings("about")}>查看详情</button>
        <button className="native-update-close" aria-label="关闭更新提醒" title="不再提醒这个版本" onClick={() => {
          void request<UpdateStatus>("/api/native/updates/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: update.latest }) }).then(setUpdate, cause => setError(String(cause)));
        }}><X size={16} /></button>
      </div>}
      {settingsOpen ? <NativeSettings
        key={settingsSection}
        initialSection={settingsSection}
        onOpenSession={id => { session.select(id); setSettingsOpen(false); }}
        onUseSkill={name => { session.prefill(`/skill:${name} `); setSettingsOpen(false); }}
        theme={theme} setTheme={setTheme}
        config={config}
        catalog={catalog}
        onConfig={setConfig}
        reload={async () => {
          const loaded = await loadConfiguration();
          setConfig(loaded.config);
          setCatalog(loaded.catalog);
        }}
        onClose={() => setSettingsOpen(false)}
        fontSize={fontSize}
        setFontSize={setFontSize}
        diagnostics={diagnostics}
        setDiagnostics={setDiagnostics}
        update={update}
        onCheckUpdate={() => void request<UpdateStatus>("/api/native/updates/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(setUpdate, cause => setError(String(cause)))}
        sessionId={session.selected}
      />
        : session.current ? <NativeThread session={session} sessionInfo={session.current} models={catalog?.models ?? []} onOpenFile={openFile} onOpenSettings={openSettings} workspaceActions={workspaceActions} />
        : <><header className="native-header native-home-header"><strong>新会话</strong>{workspaceActions}</header><NativeHome
          session={session}
          catalog={catalog}
          config={config}
          projectPath={projectPath}
          setProjectPath={setProjectPath}
          onOpenSettings={openSettings}
        /></>}
    </main>
    {showWorkspace && <NativeWorkspace session={session} diagnostics={diagnostics} tab={workspaceTab} setTab={setWorkspaceTab} onClose={closeWorkspace} previewPath={previewPath} onPreviewPath={setPreviewPath} onOpenFile={openFile} onResize={width => setWorkspaceWidth(Math.max(320, Math.min(width, 560)))} />}
    {displayError && <div className="native-error" role="alert"><strong>{help.title}</strong><p>{help.hint}</p><details><summary>具体原因</summary><p>{displayError}</p></details>
      {help.section && <button onClick={() => openSettings(help.section)}>打开相关设置</button>}
      <button onClick={() => { session.refresh(); void session.reloadList().then(() => { if (!session.selected) return loadConfiguration().then(loaded => { setCatalog(loaded.catalog); setConfig(loaded.config); }); }).catch(cause => setError(String(cause))); }}>刷新状态</button>
      <button onClick={() => { session.setError(""); setError(""); }}>关闭</button></div>}
    <NativeDialogs session={session} />
  </div>;
}
