/**
 * 桌面工作台外壳（方案 8.2）：拆分为 Sidebar / Home / Thread / Workspace / Dialogs 与 useSession。
 * Alpha 工作台：按需展开工作区，保留原生会话与配置契约。
 */

import { desktopStorage } from "./desktop-storage";
import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, FolderOpen, Globe2, PanelRightClose, Terminal, Command, X } from "lucide-react";
import { loadConfiguration, request, sessionRequest, type NativeCatalog, type NativeConfig, type UpdateStatus } from "./native-api";
import { NativeDialogs } from "./NativeDialogs";
import { NativeHome } from "./NativeHome";
import { NativeSettings } from "./NativeSettings";
import { NativeSidebar } from "./NativeSidebar";
import { NativeThread, absoluteArtifactPath } from "./NativeThread";
import { NativeWorkspace, type WorkspaceTab } from "./NativeWorkspace";
import { nativeImages, useSession } from "./useSession";
import { NativeCommands } from "./NativeCommands";
import { NativeSessionTools } from "./NativeSessionTools";
import { NativeProjects } from "./NativeProjects";
import { invokeDesktopCommand, shortcutCommand, type DesktopCommandEvent } from "./desktop-commands";
import "./NativeApp.css";
import { errorHelp, readDraft } from "./workbench-state";

export function NativeApp() {
  const session = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [sessionTools, setSessionTools] = useState<"history" | "progress" | null>(null);
  const [settingsSection, setSettingsSection] = useState("model");
  const openSettings = (section = "model") => { setSettingsSection(section); setSettingsOpen(true); };
  const [projectPath, setProjectPath] = useState(() => readDraft("home", desktopStorage).cwd ?? "");
  const [config, setConfig] = useState<NativeConfig | null>(null);
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [fontSize, setFontSize] = useState(() => Number(desktopStorage.getItem("alpha-native-font-size")) || 15);
  const [theme, setTheme] = useState(() => desktopStorage.getItem("alpha-theme") ?? "light");
  const [workspaceWidth, setWorkspaceWidth] = useState(() => Math.max(320, Math.min(Number(desktopStorage.getItem("alpha-workspace-width")) || 400, 560)));
  const [preview, setPreview] = useState<{ id: string; path: string } | null>(null);
  const previewPath = preview?.id === session.selected ? preview.path : null;
  const setPreviewPath = (path: string | null) => setPreview(path && session.selected ? { id: session.selected, path } : null);
  const [workspaceVisible, setWorkspaceVisible] = useState(false);
  const workspaceTrigger = useRef<HTMLElement | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(() => {
    const saved = desktopStorage.getItem("alpha-native-workspace-tab");
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth < 760 || desktopStorage.getItem("alpha-native-sidebar-collapsed") === "true");
  const [diagnostics, setDiagnostics] = useState(() => desktopStorage.getItem("alpha-native-diagnostics") === "1");
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
  useEffect(() => { desktopStorage.setItem("alpha-native-font-size", String(fontSize)); }, [fontSize]);
  useEffect(() => { desktopStorage.setItem("alpha-theme", theme); document.documentElement.dataset.alphaTheme = theme; }, [theme]);
  useEffect(() => { desktopStorage.setItem("alpha-workspace-width", String(workspaceWidth)); }, [workspaceWidth]);
  useEffect(() => { desktopStorage.setItem("alpha-native-workspace-tab", workspaceTab); }, [workspaceTab]);
  useEffect(() => { desktopStorage.setItem("alpha-native-sidebar-collapsed", String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { desktopStorage.setItem("alpha-native-diagnostics", diagnostics ? "1" : "0"); }, [diagnostics]);

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
    const handler = (event: Event) => {
      const command = event as CustomEvent<DesktopCommandEvent>;
      command.preventDefault();
      void (async () => {
        const { id, args, image } = command.detail;
        if (id === "palette") setPaletteOpen(true);
        else if (id === "new") selectSession(null);
        else if (id === "settings") openSettings();
        else if (id === "projects") setProjectsOpen(true);
        else if (["skills", "mcp", "plugins"].includes(id)) openSettings(id);
        else if (["files", "review", "terminal"].includes(id)) { if (id === "files" && args) openFile(args); else openWorkspace(id as WorkspaceTab); }
        else {
          if (!session.selected || !session.opened) throw new Error("请先打开会话");
          if (id === "history" || id === "progress") setSessionTools(id);
          else if (id === "plan" || id === "planreview") {
            await sessionRequest(session.selected, "host/plan", { action: id === "planreview" ? "review" : args ? "resume" : "toggle" });
            if (args) await sessionRequest(session.selected, "command", { type: session.state?.isStreaming ? "steer" : "prompt", message: args, ...(image ? { images: nativeImages(image) } : {}) });
            session.refresh();
          } else if (id === "compact") await session.command({ type: "compact" });
          else if (id === "export") {
            const exported = await sessionRequest<{ name: string; content: string }>(session.selected, "export", {});
            if (window.alpha?.saveText) await window.alpha.saveText(exported.name, exported.content);
            else {
              const url = URL.createObjectURL(new Blob([exported.content], { type: "text/html;charset=utf-8" }));
              const link = document.createElement("a"); link.href = url; link.download = exported.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
          }
        }
        return true;
      })().then(success => command.detail.resolve?.(success), cause => { session.setError(String(cause)); command.detail.resolve?.(false); });
    };
    window.addEventListener("alpha-command", handler);
    return () => window.removeEventListener("alpha-command", handler);
  });

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.isComposing || document.querySelector('[aria-modal="true"]')) return;
      const command = shortcutCommand(event);
      if (command) { event.preventDefault(); void invokeDesktopCommand(command); }
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
    <button onClick={() => void invokeDesktopCommand("palette")} aria-label="命令面板" title="命令面板 · Ctrl+K"><Command size={17} /></button>
    {showWorkspace ? <button onClick={closeWorkspace} aria-label="收起工作区" title="收起工作区" aria-controls="native-workspace" aria-expanded><PanelRightClose size={18} /></button>
      : [{ id: "files" as const, label: "文件", Icon: FolderOpen }, { id: "browser" as const, label: "浏览器", Icon: Globe2 }, { id: "review" as const, label: "审查", Icon: ClipboardCheck }, { id: "terminal" as const, label: "终端", Icon: Terminal }].map(({ id, label, Icon }) =>
        <button key={id} onClick={() => id === "browser" ? openWorkspace(id) : void invokeDesktopCommand(id)} aria-label={`打开${label}栏`} title={label} aria-controls="native-workspace" aria-expanded={false}><Icon size={17} /><span>{label}</span></button>)}
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
    {paletteOpen && <NativeCommands session={session} onClose={() => setPaletteOpen(false)} />}
    {projectsOpen && <NativeProjects session={session} onClose={() => setProjectsOpen(false)} />}
    {sessionTools && session.selected && session.opened && <NativeSessionTools key={session.selected} session={session} initial={sessionTools} onClose={() => setSessionTools(null)} />}
  </div>;
}
