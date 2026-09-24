import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { X } from "lucide-react";
import { PreviewPane } from "../components/PreviewPane";
import { Sidebar } from "../components/Sidebar";
import { useStore } from "../state/store";
import { dismissNotice, newTask, openDetail, startWorkbench, store } from "../state/workbench";
import { Thread } from "./Thread";
import "./App.css";

const LAYOUT_KEY = "alpha.layout";
const SIDEBAR = 256;
const RAIL = 56;
const SPLITTER = 6;
const THREAD_MIN = 420;
const PREVIEW_MIN = 360;
const DEFAULT_RATIO = 0.46;

interface Layout { sidebarCollapsed: boolean; previewRatio: number }

function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Partial<Layout>;
    return {
      sidebarCollapsed: saved.sidebarCollapsed === true,
      previewRatio: typeof saved.previewRatio === "number" && saved.previewRatio > 0.15 && saved.previewRatio < 0.85 ? saved.previewRatio : DEFAULT_RATIO,
    };
  } catch {
    return { sidebarCollapsed: false, previewRatio: DEFAULT_RATIO };
  }
}

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
  const [layout, setLayout] = useState(readLayout);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const dragging = useRef(false);

  useEffect(() => startWorkbench(), []);

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* Layout memory is optional. */ }
  }, [layout]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newTask();
      } else if (event.key === "Escape" && store.get().detail) {
        openDetail(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sidebarWidth = layout.sidebarCollapsed ? RAIL : SIDEBAR;
  const available = Math.max(0, viewport - sidebarWidth - SPLITTER);
  const previewWidth = Math.min(Math.max(Math.round(available * layout.previewRatio), PREVIEW_MIN), Math.max(PREVIEW_MIN, available - THREAD_MIN));

  const setRatio = (ratio: number) => setLayout(current => ({ ...current, previewRatio: Math.min(0.8, Math.max(0.2, ratio)) }));
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !available) return;
    setRatio((viewport - event.clientX - SPLITTER / 2) / available);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onSplitterKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setRatio(layout.previewRatio + 0.03);
    else if (event.key === "ArrowRight") setRatio(layout.previewRatio - 0.03);
  };

  return <div className="workbench" data-testid="workbench" style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr) ${SPLITTER}px ${previewWidth}px` }}>
    <Sidebar collapsed={layout.sidebarCollapsed} onToggle={() => setLayout(current => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))} />
    <main className="thread" aria-label="任务对话" data-testid="thread">
      <Thread />
      <Toast />
    </main>
    <div
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
    />
    <PreviewPane layoutKey={`${sidebarWidth}:${previewWidth}:${viewport}`} />
  </div>;
}
