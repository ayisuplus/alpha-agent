import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { CalendarClock, Check, ChevronDown, FolderClosed, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, SlidersHorizontal, Square, X } from "lucide-react";
import type { TaskSummary } from "../api/types";
import { dayGroup, relativeTime, taskStatus, taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { newTask, openAutomations, openPalette, openSettings, openTask, store } from "../state/workbench";
import { IconButton, Spinner, StatusDot } from "./ui";
import { TaskMenu } from "./TaskMenu";
import { selectNewTaskProject } from "../state/new-task-draft";
import { NewTaskSetup } from "./NewTaskSetup";
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
  const projects = useStore(store, state => state.projects);
  const selectedId = useStore(store, state => state.selectedId);
  const connection = useStore(store, state => state.connection);
  const loaded = useStore(store, state => state.loaded);
  const settingsOpen = useStore(store, state => state.panel?.kind === "settings");
  const automationsOpen = useStore(store, state => state.panel?.kind === "automations");
  const [unreadAutomations, setUnreadAutomations] = useState(0);
  const seenRuns = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    async function checkAutomations() {
      const data = await api.automations();
      const policies = new Map(data.automations.map(item => [item.id, item.notificationPolicy]));
      const relevant = data.runs.filter(run => run.finishedAt && !run.readAt && (policies.get(run.automationId) === "all" || ["failed", "needs-input", "skipped"].includes(run.status)));
      setUnreadAutomations(relevant.length);
      const current = new Map(data.runs.map(run => [run.id, run.status]));
      if (seenRuns.current && window.alpha?.notify && store.get().settings?.notifications.enabled && !document.hasFocus()) {
        for (const run of relevant) if (seenRuns.current.get(run.id) !== run.status) {
          const name = data.automations.find(item => item.id === run.automationId)?.name ?? "自动化";
          window.alpha.notify(`Alpha · ${name}`, `自动化运行${run.status === "complete" ? "完成" : run.status === "needs-input" ? "需要处理" : "失败"}`, run.taskId ?? "");
        }
      }
      seenRuns.current = current;
    }
    void checkAutomations().catch(() => undefined);
    const timer = window.setInterval(() => void checkAutomations().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);

  const grouped = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (task: TaskSummary) => !needle || `${taskTitle(task)} ${task.objective}`.toLocaleLowerCase().includes(needle);
    const active = tasks.filter(task => !task.meta?.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const projectIds = new Set(projects.map(project => project.id));
    const shortcuts = new Map<string, TaskSummary[]>();
    for (const [label, items] of [["运行中", active.filter(task => task.running)], ["置顶", active.filter(task => task.meta?.pinned && !task.running)]] as const) {
      const shown = items.filter(matches);
      if (shown.length) shortcuts.set(label, shown);
    }
    const projectGroups = projects.map(project => ({ project, items: active.filter(task => task.projectId === project.id && (matches(task) || project.name.toLocaleLowerCase().includes(needle))) }))
      .filter(group => !needle || group.items.length || group.project.name.toLocaleLowerCase().includes(needle));
    const independent = new Map<string, TaskSummary[]>();
    for (const task of active.filter(task => (!task.projectId || !projectIds.has(task.projectId)) && !task.running && !task.meta?.pinned && matches(task))) {
      const key = dayGroup(task.updatedAt);
      independent.set(key, [...(independent.get(key) ?? []), task]);
    }
    if (showArchived) {
      const archived = tasks.filter(task => task.meta?.archived && matches(task)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (archived.length) independent.set("已归档", archived);
    }
    return { shortcuts: [...shortcuts], projectGroups, independent: [...independent] };
  }, [tasks, projects, query, showArchived]);

  const connectionLabel = connection === "open" ? "已连接本机服务" : connection === "connecting" ? "正在连接…" : "连接中断，正在重连";

  const running = tasks.find(task => task.running);

  if (collapsed) {
    return <nav className="sidebar collapsed" aria-label="任务">
      <IconButton icon={PanelLeftOpen} label="展开任务栏 (Ctrl+B)" onClick={onToggle} />
      <IconButton icon={Plus} label="新建任务 (Ctrl+N)" onClick={newTask} className={selectedId === null && !settingsOpen && !automationsOpen ? "active" : undefined} />
      <IconButton icon={SlidersHorizontal} label="展开项目设置" onClick={onToggle} />
      <IconButton icon={Search} label="搜索任务和命令 (Ctrl+K)" onClick={openPalette} />
      {running && <button className={`rail-running ${running.id === selectedId && !settingsOpen ? "active" : ""}`} onClick={() => void openTask(running.id)} title={`正在运行：${taskTitle(running)}`} aria-label={`打开正在运行的任务：${taskTitle(running)}`}>
        <Spinner size={16} />
      </button>}
      <span className="sidebar-rail-spacer" />
      <IconButton icon={CalendarClock} label={`自动化${unreadAutomations ? `，${unreadAutomations} 条未读` : ""}`} onClick={openAutomations} className={automationsOpen ? "active" : undefined} />
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
    <button className="new-task-button" onClick={newTask} aria-current={selectedId === null && !settingsOpen && !automationsOpen ? "page" : undefined}>
      <Plus size={16} aria-hidden />新建任务<kbd>Ctrl N</kbd>
    </button>
    <label className="task-search">
      <Search size={14} aria-hidden />
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" />
      {query && <IconButton icon={X} label="清除搜索" size={14} onClick={() => setQuery("")} />}
    </label>
    <div className="task-groups">
      <NewTaskSetup />
      {grouped.shortcuts.map(([label, items]) => <section key={label} className="task-group">
        <h2>{label}</h2>
        {items.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId && !settingsOpen} />)}
      </section>)}
      {!!grouped.projectGroups.length && <div className="sidebar-section-label">项目</div>}
      {grouped.projectGroups.map(({ project, items }) => {
        const folded = collapsedProjects.includes(project.id);
        return <section key={project.id} className="task-group project-group">
          <div className="project-heading">
            <button className="project-toggle" aria-expanded={!folded} onClick={() => setCollapsedProjects(current => folded ? current.filter(id => id !== project.id) : [...current, project.id])}>
              <ChevronDown size={14} aria-hidden /><FolderClosed size={14} aria-hidden /><span>{project.name}</span><small>{items.length}</small>
            </button>
            <IconButton icon={Plus} label={`在「${project.name}」中新建任务`} size={14} onClick={() => selectNewTaskProject(project.id, project.mounts.length === 1 ? project.mounts[0]?.id : "")} />
          </div>
          {!folded && items.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId && !settingsOpen} />)}
        </section>;
      })}
      {!!grouped.independent.length && <div className="sidebar-section-label">独立任务</div>}
      {grouped.independent.map(([label, items]) => <section key={label} className="task-group">
        <h2>{label}</h2>
        {items.map(task => <TaskRow key={task.id} task={task} selected={task.id === selectedId && !settingsOpen} />)}
      </section>)}
      {loaded && !grouped.shortcuts.length && !grouped.projectGroups.length && !grouped.independent.length && <p className="sidebar-empty">{query ? "没有匹配的任务" : "还没有任务。新建一个，描述你想完成的事。"}</p>}
      {tasks.some(task => task.meta?.archived) && <button className="sidebar-archived" onClick={() => setShowArchived(value => !value)}>{showArchived ? "隐藏已归档" : "显示已归档"}</button>}
    </div>
    <footer className="sidebar-footer">
      <button className="sidebar-archived" onClick={openAutomations} aria-current={automationsOpen ? "page" : undefined}><CalendarClock size={15} aria-hidden /> 自动化{unreadAutomations ? ` · ${unreadAutomations}` : ""}</button>
      <span className="sidebar-status" title={connectionLabel}>
        <StatusDot tone={connection === "open" ? "success" : "warning"} pulse={connection !== "open"} />
        <span>{connection === "open" ? `${tasks.length} 个任务` : connectionLabel}</span>
      </span>
      <IconButton icon={Settings} label="设置 (Ctrl+,)" onClick={() => openSettings()} className={settingsOpen ? "active" : undefined} />
    </footer>
  </nav>;
}
