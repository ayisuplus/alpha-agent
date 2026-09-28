import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { X } from "lucide-react";
import type { Settings } from "../api/types";
import { CommandPalette } from "../components/CommandPalette";
import { Sidebar } from "../components/Sidebar";
import { WorkspacePanel, WorkspaceRail } from "../components/WorkspacePanel";
import { matchShortcut, stepScale } from "../state/shortcuts";
import { useStore } from "../state/store";
import { closePalette, closePanel, closeWorkspace, dismissNotice, newTask, notify, openDetail, openPalette, openSettings, previewLocked, showPreview, startWorkbench, store, updateSettings } from "../state/workbench";
import { Thread } from "./Thread";
import "./App.css";

const SIDEBAR = 256;
const RAIL = 56;
const WORKSPACE_RAIL = 56;
const SPLITTER = 6;
const THREAD_MIN = 420;
const PREVIEW_MIN = 360;
const NARROW = 1200;
const DEFAULT_RATIO = 0.46;
const FALLBACK_UI: Settings["ui"] = { scale: 1, fontSize: "md", sidebarCollapsed: false, previewCollapsed: false, previewRatio: DEFAULT_RATIO };

function Toast() {
  const notice = useStore(store, state => state.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismissNotice(notice.id), notice.tone === "error" ? 8_000 : 3_000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return <div className={`toast tone-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
    <span>{notice.text}</span>
    <button className="toast-close" aria-label="关闭提示" onClick={() => dismissNotice(notice.id)}><X size={14} aria-hidden /></button>
  </div>;
}

export function App() {
  const settings = useStore(store, state => state.settings);
  const loaded = useStore(store, state => state.loaded);
  const locked = useStore(store, previewLocked);
  const workspaceView = useStore(store, state => state.workspaceView);
  const selectedId = useStore(store, state => state.selectedId);
  const panelOpen = useStore(store, state => state.panel !== null);
  const [innerWidth, setInnerWidth] = useState(() => window.innerWidth);
  // On a narrow window the task list folds away; expanding it by hand holds for this session only.
  const [expandedWhileNarrow, setExpandedWhileNarrow] = useState(false);
  const dragging = useRef(false);

  useEffect(() => startWorkbench(), []);

  useEffect(() => {
    const onResize = () => setInnerWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const ui = settings?.ui ?? FALLBACK_UI;
  const scale = ui.scale;
  const viewport = innerWidth / scale;
  const narrow = viewport < NARROW;
  const sidebarCollapsed = ui.sidebarCollapsed || (narrow && (selectedId !== null || viewport < 900) && !expandedWhileNarrow);
  const sidebarWidth = sidebarCollapsed ? RAIL : SIDEBAR;
  const available = Math.max(0, viewport - sidebarWidth - SPLITTER);
  const compactColumns = viewport < 900;
  const previewMin = compactColumns ? 320 : PREVIEW_MIN;
  const threadMin = compactColumns ? 320 : THREAD_MIN;
  const previewWidth = Math.min(Math.max(Math.round(available * ui.previewRatio), previewMin), Math.max(previewMin, available - threadMin));

  const toggleSidebar = () => {
    if (sidebarCollapsed) {
      if (ui.sidebarCollapsed) void updateSettings({ ui: { sidebarCollapsed: false } }, { debounce: true });
      if (narrow) setExpandedWhileNarrow(true);
    } else if (narrow && !ui.sidebarCollapsed) setExpandedWhileNarrow(false);
    else void updateSettings({ ui: { sidebarCollapsed: true } }, { debounce: true });
  };

  const togglePreview = () => {
    if (workspaceView === "preview" && locked) {
      notify("浏览器正在使用预览，操作结束后才能收起", "info");
      return;
    }
    if (workspaceView === "preview" && (!panelOpen || locked)) closeWorkspace();
    else {
      if (panelOpen) closePanel();
      showPreview();
    }
  };

  const setScale = (next: number) => {
    if (next !== scale) void updateSettings({ ui: { scale: next } }, { debounce: true });
  };

  // Handlers change every render; the key listener reads the latest ones through a ref.
  const actions = useRef({ toggleSidebar, togglePreview, setScale, scale });
  actions.current = { toggleSidebar, togglePreview, setScale, scale };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = matchShortcut(event);
      const current = actions.current;
      if (id) event.preventDefault();
      switch (id) {
        case "new-task": newTask(); break;
        case "palette": openPalette(); break;
        case "settings": openSettings(); break;
        case "shortcuts": openSettings("shortcuts"); break;
        case "toggle-sidebar": current.toggleSidebar(); break;
        case "toggle-preview": current.togglePreview(); break;
        case "zoom-in": current.setScale(stepScale(current.scale, 1)); break;
        case "zoom-out": current.setScale(stepScale(current.scale, -1)); break;
        case "zoom-reset": current.setScale(1); break;
        default:
          if (event.key === "Escape") {
            const state = store.get();
            if (state.paletteOpen) closePalette();
            else if (state.detail) openDetail(null);
            else if (state.panel) closePanel();
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Settings and automations are not about the selected task, so its review panel steps aside for them
  // (it stays only while the browser is operating the preview) and returns unchanged when they close.
  const expanded = workspaceView !== "closed" && (!panelOpen || locked);
  const showingPreview = expanded && workspaceView === "preview";

  const setRatio = (ratio: number) => void updateSettings({ ui: { previewRatio: Math.min(0.8, Math.max(0.2, ratio)) } }, { debounce: true });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !available) return;
    // Pointer coordinates are in window pixels; the layout is measured in zoomed CSS pixels.
    setRatio(((innerWidth - event.clientX) / scale - SPLITTER / 2) / available);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onSplitterKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setRatio(ui.previewRatio + 0.03);
    else if (event.key === "ArrowRight") setRatio(ui.previewRatio - 0.03);
  };

  const columns = expanded
    ? `${sidebarWidth}px minmax(0, 1fr) ${SPLITTER}px ${previewWidth}px`
    : `${sidebarWidth}px minmax(0, 1fr) ${WORKSPACE_RAIL}px`;

  useEffect(() => {
    if (!showingPreview) window.alpha?.setPreviewBounds?.({ x: 0, y: 0, width: 0, height: 0, visible: false });
  }, [showingPreview]);

  if (!settings && !loaded) return <div className="workbench-loading" />;

  return <div className="workbench" data-testid="workbench" data-font={ui.fontSize} style={{ gridTemplateColumns: columns, zoom: scale }}>
    <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
    <main className="thread" aria-label="任务对话" data-testid="thread">
      <Thread />
      <CommandPalette toggleSidebar={toggleSidebar} togglePreview={togglePreview} />
      <Toast />
    </main>
    {expanded && <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整预览宽度（双击复位）"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setRatio(DEFAULT_RATIO)}
      onKeyDown={onSplitterKey}
    />}
    {expanded
      ? <WorkspacePanel locked={locked} layoutKey={`${sidebarWidth}:${previewWidth}:${innerWidth}:${scale}`} />
      : <WorkspaceRail />}
  </div>;
}
