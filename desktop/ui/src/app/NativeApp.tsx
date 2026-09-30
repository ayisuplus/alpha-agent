/**
 * 桌面工作台外壳（方案 8.2）：拆分为 Sidebar / Home / Thread / Workspace / Dialogs 与 useSession。
 * 视觉样式与 0.1.1 一致（复用既有样式与类名），只改文案、信息层级与接线。
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { loadConfiguration, request, type NativeCatalog, type NativeConfig, type UpdateStatus } from "./native-api";
import { NativeDialogs } from "./NativeDialogs";
import { NativeHome } from "./NativeHome";
import { NativeSettings } from "./NativeSettings";
import { NativeSidebar } from "./NativeSidebar";
import { NativeThread } from "./NativeThread";
import { NativeWorkspace } from "./NativeWorkspace";
import { useSession } from "./useSession";
import "./NativeApp.css";

export function NativeApp() {
  const session = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("model");
  const openSettings = (section = "model") => { setSettingsSection(section); setSettingsOpen(true); };
  const [projectDialog, setProjectDialog] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [config, setConfig] = useState<NativeConfig | null>(null);
  const [catalog, setCatalog] = useState<NativeCatalog | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem("alpha-native-font-size")) || 14);
  const [workspaceVisible, setWorkspaceVisible] = useState(() => localStorage.getItem("alpha-native-workspace") !== "false");
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
  useEffect(() => { localStorage.setItem("alpha-native-workspace", String(workspaceVisible)); }, [workspaceVisible]);
  useEffect(() => { localStorage.setItem("alpha-native-diagnostics", diagnostics ? "1" : "0"); }, [diagnostics]);

  useEffect(() => {
    void request<UpdateStatus>("/api/native/updates").then(setUpdate, cause => setError(String(cause)));
  }, []);
  useEffect(() => {
    // 系统通知只报一次；文案与横幅一致（OMP 只在横幅与“关于”页出现）。
    if (!update?.available || !update.latest || update.notifiedVersion === update.latest || alertedVersion.current === update.latest || !window.alpha?.notify) return;
    alertedVersion.current = update.latest;
    window.alpha.notify("OMP 内核有新版本", `OMP 内核有新版本 ${update.latest}（当前 ${update.current}），升级需在开发环境中进行。`, "omp-update");
    window.alpha.attention?.();
    void request<UpdateStatus>("/api/native/updates/notified", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: update.latest }) }).then(setUpdate, cause => setError(String(cause)));
  }, [update]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); setSettingsOpen(true); }
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  const displayError = session.error || error;
  return <div className={`native-workbench ${!session.current || settingsOpen || !workspaceVisible ? "native-wide" : ""}`} style={{ "--native-message-size": `${fontSize}px` } as React.CSSProperties}>
    <NativeSidebar
      sessions={session.sessions}
      legacy={session.legacy}
      selected={session.selected}
      busy={session.busy}
      onSelect={id => { session.select(id); setSettingsOpen(false); }}
      onNew={() => { session.select(null); setSettingsOpen(false); }}
      onNewElsewhere={() => { setProjectPath(""); setProjectDialog(true); }}
      onContinueLegacy={task => void session.continueLegacy(task)}
      onOpenSettings={openSettings}
    />
    <main className="native-main">
      {update?.available && update.latest && <div className="native-update-banner" role="status">
        <strong>OMP 内核有新版本 {update.latest}</strong>
        <span>（当前 {update.current}），升级需在开发环境中进行。</span>
        <button onClick={() => {
          const url = "https://github.com/can1357/oh-my-pi/releases";
          if (window.alpha?.openExternal) void window.alpha.openExternal(url);
          else window.open(url, "_blank");
        }}>发布说明</button>
      </div>}
      {settingsOpen ? <NativeSettings
        key={settingsSection}
        initialSection={settingsSection}
        onOpenSession={id => { session.select(id); setSettingsOpen(false); }}
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
        : session.current ? <NativeThread session={session} sessionInfo={session.current} onOpenSettings={openSettings} />
        : <NativeHome
          session={session}
          catalog={catalog}
          config={config}
          projectPath={projectPath}
          setProjectPath={setProjectPath}
          onOpenSettings={openSettings}
        />}
    </main>
    {session.current && workspaceVisible && !settingsOpen && <NativeWorkspace session={session} diagnostics={diagnostics} />}
    {displayError && <div className="native-error" role="alert">{displayError}<button onClick={() => { session.setError(""); setError(""); }}>关闭</button></div>}
    <NativeDialogs
      session={session}
      projectDialog={projectDialog}
      closeProjectDialog={() => setProjectDialog(false)}
      projectPath={projectPath}
      setProjectPath={setProjectPath}
    />
  </div>;
}
