/**
 * 桌面工作台外壳（方案 8.2）：拆分为 Sidebar / Home / Thread / Workspace / Dialogs 与 useSession。
 * 视觉样式与 0.1.1 一致（复用既有样式与类名），只改文案、信息层级与接线。
 */

import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, FolderOpen, Globe2, Terminal, X } from "lucide-react";
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
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectPath, setProjectPath] = useState(() => readDraft("home", localStorage).cwd ?? "");
  const [dialogPath, setDialogPath] = useState("");
  const [config, setConfig] = useState<NativeConfig | null>(null);
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem("alpha-native-font-size")) || 14);
  const [theme, setTheme] = useState(() => localStorage.getItem("alpha-theme") ?? "light");
  const [workspaceWidth, setWorkspaceWidth] = useState(() => Number(localStorage.getItem("alpha-workspace-width")) || 380);
  const [preview, setPreview] = useState<{ id: string; path: string } | null>(null);
  const previewPath = preview?.id === session.selected ? preview.path : null;
  const setPreviewPath = (path: string | null) => setPreview(path && session.selected ? { id: session.selected, path } : null);
  const [workspaceVisible, setWorkspaceVisible] = useState(() => localStorage.getItem("alpha-native-workspace") !== "false");
  const [workspaceRequested, setWorkspaceRequested] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(() => {
    const saved = localStorage.getItem("alpha-native-workspace-tab");
    return saved === "review" || saved === "terminal" || saved === "files" || saved === "logs" ? saved : "browser";
  });
  const openWorkspace = (tab: WorkspaceTab) => { setWorkspaceTab(tab); setWorkspaceVisible(true); setWorkspaceRequested(true); setSettingsOpen(false); };
  const openFile = (path: string) => { setPreviewPath(absoluteArtifactPath(path, session.current?.cwd)); openWorkspace("files"); };
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("alpha-native-sidebar-collapsed") === "true");
  const [diagnostics, setDiagnostics] = useState(() => localStorage.getItem("alpha-native-diagnostics") === "1");
  const [error, setError] = useState("");
  const alertedVersion = useRef<string | null>(null);

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
  useEffect(() => { localStorage.setItem("alpha-native-workspace", String(workspaceVisible)); }, [workspaceVisible]);
  useEffect(() => { localStorage.setItem("alpha-native-workspace-tab", workspaceTab); }, [workspaceTab]);
  useEffect(() => { localStorage.setItem("alpha-native-sidebar-collapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem("alpha-native-diagnostics", diagnostics ? "1" : "0"); }, [diagnostics]);

  useEffect(() => {
    void request<UpdateStatus>("/api/native/updates").then(setUpdate, cause => setError(String(cause)));
  }, []);
  useEffect(() => {
    // 系统通知只报一次；文案与横幅一致（OMP 只在横幅与“关于”页出现）。
    if (!update?.available || !update.latest || update.dismissedVersion === update.latest || update.notifiedVersion === update.latest || alertedVersion.current === update.latest || !window.alpha?.notify) return;
    alertedVersion.current = update.latest;
    window.alpha.notify("OMP 内核有新版本", `OMP 内核有新版本 ${update.latest}（当前 ${update.current}），升级需在开发环境中进行。`, "omp-update");
    window.alpha.attention?.();
    void request<UpdateStatus>("/api/native/updates/notified", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: update.latest }) }).then(setUpdate, cause => setError(String(cause)));
  }, [update]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettingsOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); session.select(null); setSettingsOpen(false); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); openWorkspace("files"); }
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  const displayError = session.error || error;
  const showWorkspace = workspaceVisible && !settingsOpen && !!(session.current || workspaceRequested);
  const help = errorHelp(displayError);
  return <div className={`native-workbench ${!showWorkspace ? "native-wide" : ""} ${sidebarCollapsed ? "native-sidebar-collapsed" : ""}`} style={{ "--native-message-size": `${fontSize}px`, "--ui-font-size": `${fontSize}px`, "--native-workspace-width": `${workspaceWidth}px` } as React.CSSProperties}>
    <NativeSidebar
      collapsed={sidebarCollapsed}
      onToggle={() => setSidebarCollapsed(value => !value)}
      sessions={session.sessions}
      legacy={session.legacy}
      selected={session.selected}
      busy={session.busy}
      onSelect={id => { session.select(id); setSettingsOpen(false); }}
      onNew={() => { session.select(null); setSettingsOpen(false); }}
      onNewElsewhere={() => { setDialogPath(""); setProjectDialog(true); }}
      onContinueLegacy={task => void session.continueLegacy(task)}
      onOpenSettings={openSettings}
    />
    <main className="native-main">
      {update?.available && update.latest && update.dismissedVersion !== update.latest && <div className="native-update-banner" role="status">
        <strong>OMP 内核有新版本 {update.latest}</strong>
        <span>（当前 {update.current}），升级需在开发环境中进行。</span>
        <button onClick={() => {
          const url = "https://github.com/can1357/oh-my-pi/releases";
          if (window.alpha?.openExternal) void window.alpha.openExternal(url);
          else window.open(url, "_blank");
        }}>发布说明</button>
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
        workspaceVisible={workspaceVisible}
        setWorkspaceVisible={setWorkspaceVisible}
        diagnostics={diagnostics}
        setDiagnostics={setDiagnostics}
        update={update}
        onCheckUpdate={() => void request<UpdateStatus>("/api/native/updates/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(setUpdate, cause => setError(String(cause)))}
        sessionId={session.selected}
      />
        : session.current ? <NativeThread session={session} sessionInfo={session.current} models={catalog?.models ?? []} onOpenFile={openFile} onOpenSettings={openSettings} onOpenTerminal={() => openWorkspace("terminal")} />
        : <NativeHome
          session={session}
          catalog={catalog}
          config={config}
          projectPath={projectPath}
          setProjectPath={setProjectPath}
          onOpenSettings={openSettings}
        />}
    </main>
    {showWorkspace && <NativeWorkspace session={session} diagnostics={diagnostics} tab={workspaceTab} setTab={setWorkspaceTab} onClose={() => setWorkspaceVisible(false)} previewPath={previewPath} onPreviewPath={setPreviewPath} onOpenFile={openFile} onResize={width => setWorkspaceWidth(Math.max(280, Math.min(width, window.innerWidth - 200)))} />}
    <nav className="native-workspace-rail" aria-label="右侧工作区入口">
      {[{ id: "review" as const, label: "审查", Icon: ClipboardCheck }, { id: "terminal" as const, label: "终端", Icon: Terminal }, { id: "browser" as const, label: "浏览器", Icon: Globe2 }, { id: "files" as const, label: "文件", Icon: FolderOpen }].map(({ id, label, Icon }) =>
        <button key={id} onClick={() => openWorkspace(id)} aria-label={`打开${label}栏`} title={label} aria-controls="native-workspace" aria-expanded={showWorkspace && workspaceTab === id}><Icon size={18} /><span>{label}</span></button>)}
    </nav>
    {displayError && <div className="native-error" role="alert"><strong>{help.title}</strong><p>{help.hint}</p><details><summary>具体原因</summary><p>{displayError}</p></details>
      {help.section && <button onClick={() => openSettings(help.section)}>打开相关设置</button>}
      <button onClick={() => { session.refresh(); void session.reloadList().then(() => { if (!session.selected) return loadConfiguration().then(loaded => { setCatalog(loaded.catalog); setConfig(loaded.config); }); }).catch(cause => setError(String(cause))); }}>刷新状态</button>
      <button onClick={() => { session.setError(""); setError(""); }}>关闭</button></div>}
    <NativeDialogs
      session={session}
      projectDialog={projectDialog}
      closeProjectDialog={() => setProjectDialog(false)}
      projectPath={dialogPath}
      setProjectPath={setDialogPath}
    />
  </div>;
}
