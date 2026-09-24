import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { closePalette, exportTaskReport, newTask, openProductFolder, openSettings, openTask, republish, stopTask, store } from "../state/workbench";
import "./CommandPalette.css";

interface Command { id: string; label: string; detail?: string; run(): void }

export function CommandPalette({ toggleSidebar, togglePreview }: { toggleSidebar(): void; togglePreview(): void }) {
  const open = useStore(store, state => state.paletteOpen);
  const tasks = useStore(store, state => state.tasks);
  const task = useStore(store, state => state.task);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: "new", label: "新建任务", run: newTask },
      { id: "settings", label: "打开设置", run: () => openSettings() },
      { id: "sidebar", label: "收起或展开任务栏", run: toggleSidebar },
      { id: "preview", label: "收起或展开预览栏", run: togglePreview },
    ];
    if (task) {
      if (task.running) base.push({ id: "stop", label: "停止当前任务", run: () => void stopTask() });
      else base.push({ id: "republish", label: "重新发布并验收", run: () => void republish() });
      base.push({ id: "export", label: "导出当前任务报告", run: () => void exportTaskReport(task.id) },
        { id: "folder", label: "打开产品目录", run: () => void openProductFolder(task.id) });
    }
    return [...base, ...tasks.map(item => ({ id: item.id, label: taskTitle(item), detail: item.meta?.archived ? "已归档任务" : "任务", run: () => void openTask(item.id) }))];
  }, [tasks, task, toggleSidebar, togglePreview]);
  if (!open) return null;
  const needle = query.trim().toLocaleLowerCase();
  const visible = commands.filter(item => !needle || `${item.label} ${item.detail ?? ""}`.toLocaleLowerCase().includes(needle)).slice(0, 30);
  const run = (command: Command) => { closePalette(); setQuery(""); setIndex(0); command.run(); };

  return <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closePalette(); }}>
    <div className="command-palette" role="dialog" aria-label="搜索任务和命令">
      <label className="palette-search"><Search size={17} aria-hidden />
        <input autoFocus value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} placeholder="搜索任务或命令…"
          onKeyDown={event => {
            if (event.key === "Escape") { event.stopPropagation(); closePalette(); }
            if (event.key === "ArrowDown") { event.preventDefault(); setIndex(value => Math.min(value + 1, Math.max(0, visible.length - 1))); }
            if (event.key === "ArrowUp") { event.preventDefault(); setIndex(value => Math.max(value - 1, 0)); }
            if (event.key === "Enter" && visible[index]) { event.preventDefault(); run(visible[index]); }
          }} />
      </label>
      <div className="palette-results">
        {visible.map((item, position) => <button key={item.id} className={position === index ? "selected" : ""}
          onMouseEnter={() => setIndex(position)} onClick={() => run(item)}>
          <span>{item.label}</span><small>{item.detail ?? "命令"}</small>
        </button>)}
        {!visible.length && <p>没有匹配的任务或命令</p>}
      </div>
      <footer>↑↓ 选择 · Enter 执行 · Esc 关闭</footer>
    </div>
  </div>;
}
