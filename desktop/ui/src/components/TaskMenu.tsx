import { useEffect, useRef, useState } from "react";
import type { TaskSummary } from "../api/types";
import { taskTitle } from "../state/labels";
import { copyTaskId, exportTaskReport, openPreviewInBrowser, openProductFolder, updateTaskMeta } from "../state/workbench";
import "./TaskMenu.css";

export function TaskMenu({ task, open, onClose, placement = "down" }: { task: TaskSummary; open: boolean; onClose(): void; placement?: "up" | "down" }) {
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(task.meta?.title ?? taskTitle(task));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) { setRenaming(false); return; }
    setTitle(task.meta?.title ?? taskTitle(task));
    const closeOutside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) closeRef.current(); };
    window.addEventListener("mousedown", closeOutside);
    return () => window.removeEventListener("mousedown", closeOutside);
  }, [open, task.meta?.title]);

  if (!open) return null;
  const action = (work: () => Promise<unknown>) => { onClose(); void work(); };
  const rename = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const saved = await updateTaskMeta(task.id, { title: title.trim() });
    setSaving(false);
    if (saved) onClose();
  };

  return <div className={`task-menu ${placement}`} ref={root} role="menu" aria-label={`${taskTitle(task)} 的操作`}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    {renaming ? <form className="task-menu-rename" onSubmit={event => { event.preventDefault(); void rename(); }}>
      <input aria-label="任务标题" autoFocus value={title} maxLength={80} onChange={event => setTitle(event.target.value)} />
      <button type="submit" disabled={saving || !title.trim()}>保存</button>
    </form> : <button role="menuitem" onClick={() => setRenaming(true)}>重命名</button>}
    <button role="menuitem" onClick={() => action(() => updateTaskMeta(task.id, { pinned: !task.meta?.pinned }))}>{task.meta?.pinned ? "取消置顶" : "置顶"}</button>
    <button role="menuitem" disabled={task.running && !task.meta?.archived} onClick={() => action(() => updateTaskMeta(task.id, { archived: !task.meta?.archived }))}>
      {task.meta?.archived ? "恢复任务" : "归档任务"}
    </button>
    <span className="task-menu-divider" />
    <button role="menuitem" onClick={() => action(() => openProductFolder(task.id))}>打开产品目录</button>
    <button role="menuitem" onClick={() => action(() => openPreviewInBrowser(task.id))}>在浏览器中打开预览</button>
    <button role="menuitem" onClick={() => action(() => exportTaskReport(task.id))}>导出报告</button>
    <button role="menuitem" onClick={() => action(() => copyTaskId(task.id))}>复制任务 ID</button>
  </div>;
}
