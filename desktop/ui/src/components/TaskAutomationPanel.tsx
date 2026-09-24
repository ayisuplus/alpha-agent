import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { LocalSchedule, QueueItem, TaskView } from "../api/types";
import { notify } from "../state/workbench";

export function TaskAutomationPanel({ task }: { task: TaskView }) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [at, setAt] = useState("");
  const [interval, setIntervalMinutes] = useState(0);
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
  const submit = async (scheduled: boolean) => {
    if (!instruction.trim() || saving) return;
    setSaving(true);
    try {
      if (scheduled) {
        if (!at) throw new Error("请选择首次运行时间");
        await api.scheduleTask(task.id, instruction.trim(), new Date(at).toISOString(), interval > 0 ? interval : null);
      } else await api.enqueueTask(task.id, instruction.trim());
      setInstruction("");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <section className="task-automation-panel" style={{ padding: "8px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
    <button className="link-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起任务队列与定时" : "任务队列与定时"}</button>
    {open && <div style={{ display: "grid", gap: 8, paddingTop: 8 }}>
      <input className="settings-text" aria-label="待执行要求" value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="下一轮要完成的具体要求" />
      <div className="settings-inline">
        <button onClick={() => void submit(false)} disabled={!instruction.trim() || saving}>加入队列</button>
        <input type="datetime-local" aria-label="首次运行时间" value={at} onChange={event => setAt(event.target.value)} />
        <label>间隔分钟（0 为一次） <input type="number" min={0} max={10080} value={interval} onChange={event => setIntervalMinutes(Number(event.target.value))} style={{ width: 75 }} /></label>
        <button onClick={() => void submit(true)} disabled={!instruction.trim() || !at || saving}>设置本机定时</button>
      </div>
      {schedules.map(item => <div key={item.id}>下次 {new Date(item.nextRunAt).toLocaleString()} · {item.intervalMinutes ? `每 ${item.intervalMinutes} 分钟` : "一次"} · {item.instruction} <button className="link-button" onClick={() => void api.disableSchedule(item.id).then(refresh).catch(error => notify(String(error)))}>停用</button></div>)}
      {items.map(item => <div key={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.status} · {item.scheduledFor ? `原定 ${new Date(item.scheduledFor).toLocaleString()}，错过 ${item.missedCount ?? 0} 次 · ` : ""}{item.result ?? item.instruction}{item.status === "pending" && <button className="link-button" onClick={() => void api.cancelQueuedTask(item.id).then(refresh).catch(error => notify(String(error)))}>取消</button>}</div>)}
    </div>}
  </section>;
}
