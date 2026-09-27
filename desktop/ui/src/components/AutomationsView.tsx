import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../api/client";
import type { Automation, AutomationRun } from "../api/types";
import { useStore } from "../state/store";
import { closePanel, openTask, store } from "../state/workbench";
import { ModelPicker } from "./ModelPicker";
import "./AutomationsView.css";

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const dayNames = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
type Cadence = "once" | "hourly" | "daily" | "weekly";

export function AutomationsView() {
  const tasks = useStore(store, state => state.tasks);
  const projects = useStore(store, state => state.projects);
  const [items, setItems] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"cron" | "heartbeat">("cron");
  const [targetTaskId, setTargetTaskId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [mountId, setMountId] = useState("");
  const [modelSelector, setModelSelector] = useState<string | null>(null);
  const [notificationPolicy, setNotificationPolicy] = useState<"all" | "failures">("failures");
  const [cadence, setCadence] = useState<Cadence>("once");
  const [at, setAt] = useState(() => localDate(new Date(Date.now() + 5 * 60_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedProject = projects.find(project => project.id === projectId);
  const editingBackup = items.find(item => item.id === editing)?.executor === "scoped-git-backup";

  async function refresh() {
    const data = await api.automations();
    setItems(data.automations);
    setRuns(data.runs);
  }
  useEffect(() => {
    void refresh().catch(error => setError(String(error)));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  function edit(item: Automation) {
    setEditing(item.id); setName(item.name); setPrompt(item.prompt); setKind(item.kind);
    setTargetTaskId(item.targetTaskId ?? ""); setProjectId(item.projectId ?? ""); setMountId(item.mountId ?? "");
    setModelSelector(item.modelSelector); setNotificationPolicy(item.notificationPolicy);
    const rule = item.schedule.kind === "rrule" ? item.schedule.rule : "";
    setCadence(item.schedule.kind === "once" ? "once" : rule.includes("HOURLY") ? "hourly" : rule.includes("WEEKLY") ? "weekly" : "daily");
    setAt(localDate(new Date(item.schedule.kind === "once" ? item.schedule.at : item.schedule.startAt)));
    setError("");
  }
  function reset() { setEditing(null); setName(""); setPrompt(""); setKind("cron"); setTargetTaskId(""); setProjectId(""); setMountId(""); setModelSelector(null); setNotificationPolicy("failures"); setCadence("once"); setAt(localDate(new Date(Date.now() + 5 * 60_000))); setError(""); }
  async function save() {
    setBusy(true); setError("");
    try {
      const date = new Date(at);
      if (!Number.isFinite(date.getTime())) throw new Error("请选择有效时间");
      const hour = date.getHours(), minute = date.getMinutes();
      const rule = cadence === "hourly" ? `FREQ=HOURLY;BYMINUTE=${minute}` : cadence === "daily" ? `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}` : `FREQ=WEEKLY;BYDAY=${dayNames[date.getDay()]};BYHOUR=${hour};BYMINUTE=${minute}`;
      const schedule = cadence === "once" ? { kind: "once" as const, at: date.toISOString() } : { kind: "rrule" as const, rule, timeZone, startAt: date.toISOString() };
      const input = { name, prompt, kind, schedule, modelSelector, notificationPolicy, ...(kind === "heartbeat" ? { targetTaskId } : { projectId: projectId || undefined, mountId: mountId || undefined }) };
      if (editing) await api.updateAutomation(editing, input);
      else await api.createAutomation(input);
      await refresh(); reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  async function action(work: () => Promise<unknown>) { setBusy(true); setError(""); try { await work(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } finally { setBusy(false); } }

  return <div className="automations-view">
    <header className="automations-header"><div><h1>自动化</h1><p>按计划独立执行，并保存每次运行结果。时间按 {timeZone} 显示。</p></div><button aria-label="关闭自动化" onClick={closePanel}><X size={18} /></button></header>
    <div className="automations-scroll">
      <section className="automations-card">
        <h2>{editing ? "编辑自动化" : "新建自动化"}</h2>
        <label>名称<input value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="例如：每天检查项目" /></label>
        <label>执行指令<textarea value={prompt} onChange={event => setPrompt(event.target.value)} readOnly={editingBackup} rows={4} placeholder="说明每次触发后需要完成什么" /></label>
        {editingBackup && <p>此任务由限定目录的 Git 备份执行器运行；指令保留作迁移记录。</p>}
        <div className="automations-grid"><label>执行方式<select value={kind} disabled={editingBackup} onChange={event => setKind(event.target.value as "cron" | "heartbeat")}><option value="cron">每次新建任务</option><option value="heartbeat">跟进已有任务</option></select></label>
          {kind === "heartbeat" ? <label>目标任务<select value={targetTaskId} onChange={event => setTargetTaskId(event.target.value)}><option value="">选择任务</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.objective.slice(0, 70)}</option>)}</select></label> : <label>项目<select value={projectId} disabled={editingBackup} onChange={event => { setProjectId(event.target.value); setMountId(""); }}><option value="">独立任务</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
          {kind === "cron" && !!selectedProject?.mounts.length && <label>工作目录<select value={mountId} disabled={editingBackup} onChange={event => setMountId(event.target.value)}><option value="">选择目录</option>{selectedProject.mounts.map(mount => <option key={mount.id} value={mount.id}>{mount.path}</option>)}</select></label>}
          <label>计划<select value={cadence} onChange={event => setCadence(event.target.value as Cadence)}><option value="once">执行一次</option><option value="hourly">每小时</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
          <label>{cadence === "once" ? "执行时间" : "开始时间"}<input type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
          <label>运行通知<select value={notificationPolicy} onChange={event => setNotificationPolicy(event.target.value as "all" | "failures")}><option value="failures">仅失败与需处理</option><option value="all">每次结果</option></select></label>
        </div>
        {!editingBackup && <ModelPicker value={modelSelector} onChange={setModelSelector} allowDefault defaultLabel="跟随默认模型" label="执行模型" />}
        {error && <p className="automations-error" role="alert">{error}</p>}
        <div className="automations-actions"><button disabled={busy || !name.trim() || !prompt.trim() || kind === "heartbeat" && !targetTaskId || kind === "cron" && !!selectedProject?.mounts.length && !mountId} onClick={() => void save()}>{busy ? "处理中…" : editing ? "保存修改" : "创建自动化"}</button>{editing && <button onClick={reset}>取消编辑</button>}</div>
      </section>
      <section className="automations-card"><h2>已创建 · {items.length}</h2>{!items.length && <p>还没有自动化。</p>}{items.map(item => <div className="automation-item" key={item.id}><div><strong>{item.name}</strong><span>{item.status === "ACTIVE" ? "运行中" : "已暂停"} · {item.executor === "scoped-git-backup" ? "限定目录 Git 备份" : item.kind === "cron" ? "独立任务" : "跟进任务"} · 下次 {item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : "无"}</span><p>{item.prompt}</p></div><div className="automations-actions"><button disabled={busy} onClick={() => edit(item)}>编辑</button><button disabled={busy || item.status !== "ACTIVE"} onClick={() => void action(() => api.runAutomation(item.id))}>立即运行</button><button disabled={busy} onClick={() => void action(() => api.updateAutomation(item.id, { status: item.status === "ACTIVE" ? "PAUSED" : "ACTIVE" }))}>{item.status === "ACTIVE" ? "暂停" : "恢复"}</button><button disabled={busy} onClick={() => void action(() => api.deleteAutomation(item.id))}>删除</button></div></div>)}</section>
      <section className="automations-card"><h2>运行记录</h2>{!runs.length && <p>暂无运行记录。</p>}{[...runs].reverse().map(run => <div className="automation-run" key={run.id}><span>{items.find(item => item.id === run.automationId)?.name ?? "已删除的自动化"} · {new Date(run.dueAt).toLocaleString()} · {run.status}{run.missedCount ? ` · 合并 ${run.missedCount} 次错过的触发` : ""}</span>{run.result && <small>{run.result}</small>}{run.taskId && <button onClick={() => void openTask(run.taskId!)}>查看任务</button>}{run.finishedAt && !run.readAt && <button onClick={() => void action(() => api.readAutomationRun(run.id))}>标记已读</button>}</div>)}</section>
    </div>
  </div>;
}
