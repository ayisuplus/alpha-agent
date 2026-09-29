import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../api/client";
import type { Automation, AutomationRun } from "../api/types";
import { formatDateTime, taskTitle, type Tone } from "../state/labels";
import { useStore } from "../state/store";
import { closePanel, openTask, store } from "../state/workbench";
import { ModelPicker } from "./ModelPicker";
import { Badge, Button, IconButton } from "./ui";
import "./AutomationsView.css";

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const dayNames = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
type Cadence = "once" | "hourly" | "daily" | "weekly";
const weekdayNames: Record<string, string> = { SU: "日", MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六" };

function scheduleText(item: Automation): string {
  if (item.schedule.kind === "once") return `执行一次 · ${formatDateTime(item.schedule.at)}`;
  const rule = item.schedule.rule;
  const start = new Date(item.schedule.startAt);
  const field = (name: string) => new RegExp(`${name}=([^;]+)`).exec(rule)?.[1];
  const minute = String(field("BYMINUTE") ?? start.getMinutes()).padStart(2, "0");
  const time = `${String(field("BYHOUR") ?? start.getHours()).padStart(2, "0")}:${minute}`;
  if (rule.includes("HOURLY")) return `每小时第 ${minute} 分`;
  if (rule.includes("WEEKLY")) return `每周${(field("BYDAY") ?? "").split(",").map(day => weekdayNames[day] ?? day).join("、")} ${time}`;
  return `每天 ${time}`;
}

export function AutomationsView() {
  const tasks = useStore(store, state => state.tasks);
  const projects = useStore(store, state => state.projects);
  const [items, setItems] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"cron" | "heartbeat">("cron");
  const [runMode, setRunMode] = useState<"notice" | "light" | "full">("light");
  const [targetTaskId, setTargetTaskId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [mountId, setMountId] = useState("");
  const [modelSelector, setModelSelector] = useState<string | null>(null);
  const [notificationPolicy, setNotificationPolicy] = useState<"all" | "failures">("failures");
  const [cadence, setCadence] = useState<Cadence>("once");
  const [at, setAt] = useState(() => localDate(new Date(Date.now() + 5 * 60_000)));
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
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
    setRunMode(item.runMode ?? "full");
    setTargetTaskId(item.targetTaskId ?? ""); setProjectId(item.projectId ?? ""); setMountId(item.mountId ?? "");
    setModelSelector(item.modelSelector); setNotificationPolicy(item.notificationPolicy);
    const rule = item.schedule.kind === "rrule" ? item.schedule.rule : "";
    setCadence(item.schedule.kind === "once" ? "once" : rule.includes("HOURLY") ? "hourly" : rule.includes("WEEKLY") ? "weekly" : "daily");
    setAt(localDate(new Date(item.schedule.kind === "once" ? item.schedule.at : item.schedule.startAt)));
    setError("");
    setFormOpen(true);
  }
  function reset() { setEditing(null); setName(""); setPrompt(""); setKind("cron"); setRunMode("light"); setTargetTaskId(""); setProjectId(""); setMountId(""); setModelSelector(null); setNotificationPolicy("failures"); setCadence("once"); setAt(localDate(new Date(Date.now() + 5 * 60_000))); setError(""); setFormOpen(false); }
  async function save() {
    setBusy(true); setError("");
    try {
      const date = new Date(at);
      if (!Number.isFinite(date.getTime())) throw new Error("请选择有效时间");
      const hour = date.getHours(), minute = date.getMinutes();
      const rule = cadence === "hourly" ? `FREQ=HOURLY;BYMINUTE=${minute}` : cadence === "daily" ? `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}` : `FREQ=WEEKLY;BYDAY=${dayNames[date.getDay()]};BYHOUR=${hour};BYMINUTE=${minute}`;
      const schedule = cadence === "once" ? { kind: "once" as const, at: date.toISOString() } : { kind: "rrule" as const, rule, timeZone, startAt: date.toISOString() };
      // The notice tier is a plain reminder: forced cron, no project directory and no model (C1/C2).
      const input = { name, prompt, kind: effectiveKind, schedule, modelSelector: runMode === "notice" ? null : modelSelector, notificationPolicy, runMode,
        ...(effectiveKind === "heartbeat" ? { targetTaskId } : runMode === "notice" ? {} : { projectId: projectId || undefined, mountId: mountId || undefined }) };
      if (editing) await api.updateAutomation(editing, input);
      else await api.createAutomation(input);
      await refresh(); reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  async function action(work: () => Promise<unknown>) { setBusy(true); setError(""); try { await work(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } finally { setBusy(false); } }

  const runLabel: Record<AutomationRun["status"], { label: string; tone: Tone }> = {
    pending: { label: "等待中", tone: "neutral" }, running: { label: "运行中", tone: "accent" }, complete: { label: "完成", tone: "success" },
    failed: { label: "失败", tone: "danger" }, "needs-input": { label: "需要处理", tone: "warning" }, skipped: { label: "已跳过", tone: "neutral" },
  };
  const shownRuns = [...runs].reverse().slice(0, allRuns ? undefined : 12);
  const noticeMode = runMode === "notice";
  const effectiveKind: "cron" | "heartbeat" = noticeMode ? "cron" : kind;
  const canSave = !busy && !!name.trim() && !!prompt.trim() && !(effectiveKind === "heartbeat" && !targetTaskId) && !(!noticeMode && effectiveKind === "cron" && !!selectedProject?.mounts.length && !mountId);
  const create = () => { reset(); setFormOpen(true); };

  return <div className="automations-view">
    <header className="automations-header">
      <div><h1>自动化</h1><p>按计划独立执行，并保存每次运行结果。只在 Alpha 运行时触发；时间按 {timeZone} 显示。</p></div>
      {!formOpen && <Button size="sm" variant="primary" icon={Plus} onClick={create}>新建自动化</Button>}
      <IconButton icon={X} label="关闭自动化 (Esc)" onClick={closePanel} />
    </header>
    <div className="automations-scroll">
      {formOpen && <section className="automations-card automations-form" aria-label={editing ? "编辑自动化" : "新建自动化"}>
        <h2>{editing ? "编辑自动化" : "新建自动化"}</h2>
        <label>名称<input value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="例如：每天检查项目" autoFocus /></label>
        <label>执行指令<textarea value={prompt} onChange={event => setPrompt(event.target.value)} readOnly={editingBackup} rows={4} placeholder="说明每次触发后需要完成什么" /></label>
        {editingBackup && <p className="automations-note">此任务由限定目录的 Git 备份执行器运行；指令保留作迁移记录。</p>}
        <div className="automations-grid"><label>执行档位<select value={runMode} onChange={event => setRunMode(event.target.value as "notice" | "light" | "full")}><option value="light">轻量运行（单轮直答）</option><option value="notice">提醒通知（不调用模型）</option><option value="full">完整任务</option></select></label>
          {!noticeMode && <label>执行方式<select value={kind} disabled={editingBackup} onChange={event => setKind(event.target.value as "cron" | "heartbeat")}><option value="cron">每次新建任务</option><option value="heartbeat">跟进已有任务</option></select></label>}
          {!noticeMode && (kind === "heartbeat" ? <label>目标任务<select value={targetTaskId} onChange={event => setTargetTaskId(event.target.value)}><option value="">选择任务</option>{tasks.map(task => <option key={task.id} value={task.id}>{taskTitle(task)}</option>)}</select></label> : <label>项目<select value={projectId} disabled={editingBackup} onChange={event => { setProjectId(event.target.value); setMountId(""); }}><option value="">独立任务</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>)}
          {!noticeMode && kind === "cron" && !!selectedProject?.mounts.length && <label>工作目录<select value={mountId} disabled={editingBackup} onChange={event => setMountId(event.target.value)}><option value="">选择目录</option>{selectedProject.mounts.map(mount => <option key={mount.id} value={mount.id}>{mount.path}</option>)}</select></label>}
          <label>计划<select value={cadence} onChange={event => setCadence(event.target.value as Cadence)}><option value="once">执行一次</option><option value="hourly">每小时</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
          <label>{cadence === "once" ? "执行时间" : "开始时间"}<input type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
          <label>运行通知<select value={notificationPolicy} onChange={event => setNotificationPolicy(event.target.value as "all" | "failures")}><option value="failures">仅失败与需处理</option><option value="all">每次结果</option></select></label>
        </div>
        {!editingBackup && !noticeMode && <ModelPicker value={modelSelector} onChange={setModelSelector} allowDefault defaultLabel="跟随默认模型" label="执行模型" />}
        {error && <p className="automations-error" role="alert">{error}</p>}
        <div className="automations-actions">
          <Button size="sm" variant="primary" disabled={!canSave} busy={busy} onClick={() => void save()}>{editing ? "保存修改" : "创建自动化"}</Button>
          <Button size="sm" variant="ghost" onClick={reset}>取消</Button>
        </div>
      </section>}
      <section className="automations-card" aria-label="已创建的自动化">
        <h2>已创建 · {items.length}</h2>
        {!formOpen && error && <p className="automations-error" role="alert">{error}</p>}
        {!items.length && <div className="automations-empty"><p>还没有自动化。可以让 Alpha 定时整理资料、检查项目或跟进一个任务。</p>{!formOpen && <Button size="sm" icon={Plus} onClick={create}>新建自动化</Button>}</div>}
        {items.map(item => <div className="automation-item" key={item.id}>
          <div className="automation-item-head">
            <strong>{item.name}</strong>
            <Badge tone={item.status === "ACTIVE" ? "success" : "neutral"}>{item.status === "ACTIVE" ? "启用中" : "已暂停"}</Badge>
          </div>
          <span className="automation-item-meta">{scheduleText(item)} · {item.executor === "scoped-git-backup" ? "限定目录 Git 备份" : item.kind === "cron" ? "每次新建任务" : "跟进已有任务"} · 下次 {item.nextRunAt ? formatDateTime(item.nextRunAt) : "无"}</span>
          <p className="automation-item-prompt" title={item.prompt}>{item.prompt}</p>
          <div className="automations-actions">
            <Button size="sm" disabled={busy} onClick={() => edit(item)}>编辑</Button>
            <Button size="sm" disabled={busy || item.status !== "ACTIVE"} onClick={() => void action(() => api.runAutomation(item.id))}>立即运行</Button>
            <Button size="sm" disabled={busy} onClick={() => void action(() => api.updateAutomation(item.id, { status: item.status === "ACTIVE" ? "PAUSED" : "ACTIVE" }))}>{item.status === "ACTIVE" ? "暂停" : "恢复"}</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => { if (window.confirm(`删除自动化「${item.name}」？已有运行记录和任务会保留。`)) void action(() => api.deleteAutomation(item.id)); }}>删除</Button>
          </div>
        </div>)}
      </section>
      <section className="automations-card" aria-label="运行记录">
        <h2>运行记录</h2>
        {!runs.length && <p className="automations-note">暂无运行记录。</p>}
        {shownRuns.map(run => {
          const state = runLabel[run.status] ?? { label: run.status, tone: "neutral" as Tone };
          return <div className="automation-run" key={run.id} data-unread={(!!run.finishedAt && !run.readAt) || undefined}>
            <div className="automation-run-head">
              <Badge tone={state.tone}>{state.label}</Badge>
              <span>{items.find(item => item.id === run.automationId)?.name ?? "已删除的自动化"} · {formatDateTime(run.dueAt)}{run.missedCount ? ` · 合并 ${run.missedCount} 次错过的触发` : ""}</span>
              {run.taskId && <button className="link-button" onClick={() => void openTask(run.taskId!)}>查看任务</button>}
              {run.finishedAt && !run.readAt && <button className="link-button" onClick={() => void action(() => api.readAutomationRun(run.id))}>标记已读</button>}
            </div>
            {run.result && <small>{run.result}</small>}
          </div>;
        })}
        {runs.length > shownRuns.length && <button className="link-button" onClick={() => setAllRuns(true)}>显示全部 {runs.length} 条</button>}
      </section>
    </div>
  </div>;
}
