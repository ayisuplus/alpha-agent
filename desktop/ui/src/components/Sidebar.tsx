import { useMemo, useState } from "react";
import { Check, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Square, X } from "lucide-react";
import type { TaskSummary } from "../api/types";
import { dayGroup, relativeTime, taskStatus, taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { newTask, openPalette, openSettings, openTask, store } from "../state/workbench";
import { IconButton, Spinner, StatusDot } from "./ui";
import { TaskMenu } from "./TaskMenu";
import "./Sidebar.css";

function TaskIcon({ task }: { task: TaskSummary }) {
  if (task.running) return <Spinner size={14} />;
  if (task.status === "complete") return <Check className="tone-text-success" size={14} aria-hidden />;
  if (task.status === "stopped") return <Square className="tone-text-muted" size={12} aria-hidden />;
  return <StatusDot tone="warning" />;
}

function TaskRow({ task, selected }: { task: TaskSummary; selected: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<"up" | "down">("down");
  const status = taskStatus(task);
  const meta = [
    status.label,
    task.contractVersion > 1 ? `v${task.contractVersion}` : null,
    relativeTime(task.updatedAt),
  ].filter(Boolean).join(" · ");
  return <div className="task-row-wrap" onContextMenu={event => { event.preventDefault(); setMenuPlacement(event.clientY > window.innerHeight * 0.55 ? "up" : "down"); setMenuOpen(true); }}>
    <button className="task-row" aria-current={selected ? "page" : undefined} onClick={() => void openTask(task.id)} title={task.originalObjective ?? task.objective}>
    <span className="task-row-icon"><TaskIcon task={task} /></span>
    <span className="task-row-body">
      <span className="task-row-title">{task.meta?.pinned ? "📌 " : ""}{taskTitle(task)}</span>
      <span className="task-row-meta">{meta}</span>
    </span>
    </button>
    <TaskMenu task={task} open={menuOpen} placement={menuPlacement} onClose={() => setMenuOpen(false)} />
  </div>;
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }) {
  const tasks = useStore(store, state => state.tasks);
  const selectedId = useStore(store, state => state.selectedId);
  const connection = useStore(store, state => state.connection);
  const loaded = useStore(store, state => state.loaded);
  const settingsOpen = useStore(store, state => state.panel?.kind === "settings");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const visible = tasks.filter(task => (showArchived || !task.meta?.archived) && (!needle || `${taskTitle(task)} ${task.objective}`.toLocaleLowerCase().includes(needle)));
    visible.sort((a, b) => Number(!!b.meta?.pinned) - Number(!!a.meta?.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    const result = new Map<string, TaskSummary[]>();
    for (const task of visible) {
      const key = task.meta?.archived ? "已归档" : task.running ? "运行中" : task.meta?.pinned ? "置顶" : dayGroup(task.updatedAt);
      result.set(key, [...(result.get(key) ?? []), task]);
    }
    return ["运行中", "置顶", "今天", "昨天", "更早", "已归档"].flatMap(key => result.has(key) ? [[key, result.get(key)!] as const] : []);
  }, [tasks, query, showArchived]);

  const connectionLabel = connection === "open" ? "已连接本机服务" : connection === "connecting" ? "正在连接…" : "连接中断，正在重连";

  const running = tasks.find(task => task.running);

  if (collapsed) {
    return <nav className="sidebar collapsed" aria-label="任务">
      <IconButton icon={PanelLeftOpen} label="展开任务栏 (Ctrl+B)" onClick={onToggle} />
      <IconButton icon={Plus} label="新建任务 (Ctrl+N)" onClick={newTask} className={selectedId === null && !settingsOpen ? "active" : undefined} />
      <IconButton icon={Search} label="搜索任务和命令 (Ctrl+K)" onClick={openPalette} />
      {running && <button className={`rail-running ${running.id === selectedId && !settingsOpen ? "active" : ""}`} onClick={() => void openTask(running.id)} title={`正在运行：${taskTitle(running)}`} aria-label={`打开正在运行的任务：${taskTitle(running)}`}>
        <Spinner size={16} />
      </button>}
      <span className="sidebar-rail-spacer" />
      <IconButton icon={Settings} label="设置 (Ctrl+,)" onClick={() => openSettings()} className={settingsOpen ? "active" : undefined} />
      <span title={connectionLabel}><StatusDot tone={connection === "open" ? "success" : "warning"} /></span>
    </nav>;
  }

  return <nav className="sidebar" aria-label="任务">
    <header className="sidebar-brand">
      <span className="brand-mark" aria-hidden>α</span>
      <span className="brand-name">Alpha<small>构建工作台</small></span>
      <IconButton icon={PanelLeftClose} label="收起任务栏 (Ctrl+B)" onClick={onToggle} />
    </header>
    <button className="new-task-button" onClick={newTask} aria-current={selectedId === null && !settingsOpen ? "page" : undefined}>
      <Plus size={16} aria-hidden />新建任务<kbd>Ctrl N</kbd>
    </button>
    <label className="task-search">
      <Search size={14} aria-hidden />
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" />
      {query && <IconButton icon={X} label="清除搜索" size={14} onClick={() => setQuery("")} />}
    </label>
    <div className="task-groups">
      {groups.map(([label, items]) => <section key={label} className="task-group">
        <h2>{label}</h2>
        {items.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId && !settingsOpen} />)}
      </section>)}
      {loaded && !groups.length && <p className="sidebar-empty">{query ? "没有匹配的任务" : "还没有任务。新建一个，描述你想要的产品。"}</p>}
      {tasks.some(task => task.meta?.archived) && <button className="sidebar-archived" onClick={() => setShowArchived(value => !value)}>{showArchived ? "隐藏已归档" : "显示已归档"}</button>}
    </div>
    <footer className="sidebar-footer">
      <span className="sidebar-status" title={connectionLabel}>
        <StatusDot tone={connection === "open" ? "success" : "warning"} pulse={connection !== "open"} />
        <span>{connection === "open" ? `${tasks.length} 个任务` : connectionLabel}</span>
      </span>
      <IconButton icon={Settings} label="设置 (Ctrl+,)" onClick={() => openSettings()} className={settingsOpen ? "active" : undefined} />
    </footer>
  </nav>;
}
