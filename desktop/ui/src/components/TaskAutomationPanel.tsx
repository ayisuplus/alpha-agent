import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { LocalSchedule, QueueItem, TaskView } from "../api/types";
import { notify } from "../state/workbench";

export function TaskAutomationPanel({ task }: { task: TaskView }) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [schedules, setSchedules] = useState<LocalSchedule[]>([]);
  const [saving, setSaving] = useState(false);
  const refresh = async () => {
    const data = await api.taskQueue();
    setItems(data.items.filter(item => item.taskId === task.id).slice(-10).reverse());
    setSchedules(data.schedules.filter(item => item.taskId === task.id && item.active));
  };
  useEffect(() => {
    if (!open) return;
    void refresh().catch(error => notify(error instanceof Error ? error.message : String(error)));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [open, task.id]);
  const submit = async () => {
    if (!instruction.trim() || saving) return;
    setSaving(true);
    try {
      await api.enqueueTask(task.id, instruction.trim());
      setInstruction("");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <section className="task-automation-panel" style={{ padding: "8px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
    <button className="link-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起待执行队列" : "待执行队列"}</button>
    {open && <div style={{ display: "grid", gap: 8, paddingTop: 8 }}>
      <input className="settings-text" aria-label="待执行要求" value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="下一轮要完成的具体要求" />
      <div className="settings-inline">
        <button onClick={() => void submit()} disabled={!instruction.trim() || saving}>加入队列</button>
      </div>
      {schedules.map(item => <div key={item.id}>旧版定时 · 下次 {new Date(item.nextRunAt).toLocaleString()} · {item.instruction} <button className="link-button" onClick={() => void api.disableSchedule(item.id).then(refresh).catch(error => notify(String(error)))}>停用</button></div>)}
      {items.map(item => <div key={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.status} · {item.scheduledFor ? `原定 ${new Date(item.scheduledFor).toLocaleString()}，错过 ${item.missedCount ?? 0} 次 · ` : ""}{item.result ?? item.instruction}{item.status === "pending" && <button className="link-button" onClick={() => void api.cancelQueuedTask(item.id).then(refresh).catch(error => notify(String(error)))}>取消</button>}</div>)}
    </div>}
  </section>;
}
