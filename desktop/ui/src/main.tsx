import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

declare global {
  interface Window {
    alpha?: { loadPreview(url: string): void; clearPreview(): void };
  }
}

type Message =
  | { type: "status"; taskId?: string; phase: string; runId?: string; pending?: string[] }
  | { type: "text"; taskId?: string; value: string }
  | { type: "tool"; taskId?: string; name: string; state: string; error?: boolean }
  | { type: "preview"; taskId?: string; url: string; previewId: string; pending: string[] }
  | { type: "task"; taskId?: string; task: TaskView }
  | { type: "control"; holder: "alpha" | "user" }
  | { type: "error"; taskId?: string; message: string };

type TaskStatus = "active" | "stopped" | "complete";
type TaskSummary = { id: string; objective: string; contractVersion: number; status: TaskStatus; running: boolean; pendingCount: number; updatedAt: string };
type EvidenceItem = { id: string; criterionId: string; passed: boolean; source: string; recordedAt: string; contractVersion: number; revision: string; previewId: string | null; current: boolean };
type TaskView = TaskSummary & { revision: string | null; acceptsGuidance: boolean; pending: string[]; criteria: Array<{ id: string; description: string }>; lastFailure: string | null; reopenReason: string | null; latestRun: { outcome: string; toolCalls: number; elapsedMs: number; failureReason?: string } | null; guidanceHistory: Array<{ id?: string; instruction: string; status?: "recorded" | "delivered" | "processed"; recordedAt: string }>; evidence: EvidenceItem[]; screenshotUrl: string | null; preview: { id: string; url: string; live: boolean } | null };
type Entry = { kind: "text" | "tool"; value: string };
type ActivityEntry = { id: string; operationId: string | null; kind: string; value: string; recordedAt: string; contractVersion: number; revision: string | null; previewId: string | null };
type ReviewSummary = { operationId: string; contractVersion: number; revision: string | null; recordedAt: string; paths: string[] };
type ReviewDetail = { operationId: string; changes: Array<{ path: string; before: string | null; after: string | null }> };
type EvidenceDetail = { content: string; screenshotUrl: string | null };
type BrowserEvidenceReport = { reason?: string; results?: Array<{ index: number; action: string; passed: boolean; detail?: string }> };

function statusLabel(task: TaskSummary): string {
  return task.running ? "运行中" : task.status === "complete" ? "已验收" : task.status === "stopped" ? "已停止" : "待验收";
}

function taskTitle(objective: string): string {
  const first = objective.split(/[。；\n]/)[0].trim();
  return first.length > 30 ? `${first.slice(0, 30)}…` : first;
}

function App() {
  const [brief, setBrief] = useState("");
  const [guidance, setGuidance] = useState("");
  const [liveGuidance, setLiveGuidance] = useState("");
  const [search, setSearch] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [phase, setPhase] = useState("准备就绪");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [currentObjective, setCurrentObjective] = useState<string | null>(null);
  const [contractVersion, setContractVersion] = useState(1);
  const [previewLive, setPreviewLive] = useState(false);
  const [controlHolder, setControlHolder] = useState<"alpha" | "user">("alpha");
  const [pending, setPending] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<TaskView["criteria"]>([]);
  const [lastFailure, setLastFailure] = useState<string | null>(null);
  const [reopenReason, setReopenReason] = useState<string | null>(null);
  const [latestRun, setLatestRun] = useState<TaskView["latestRun"]>(null);
  const [evidence, setEvidence] = useState<TaskView["evidence"]>([]);
  const [guidanceHistory, setGuidanceHistory] = useState<TaskView["guidanceHistory"]>([]);
  const [acceptsGuidance, setAcceptsGuidance] = useState(false);
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [selectedReview, setSelectedReview] = useState<ReviewDetail | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<{ id: string; detail: EvidenceDetail } | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const loadedPreviewRef = useRef<string | null>(null);
  const selectedTaskRef = useRef<string | null>(null);
  const activeTaskRef = useRef<string | null>(null);

  async function refreshTasks(): Promise<{ tasks: TaskSummary[]; activeTaskId: string | null; activeRunId: string | null }> {
    const response = await fetch("/api/tasks");
    if (!response.ok) throw new Error("无法读取任务列表");
    const result = await response.json() as { tasks: TaskSummary[]; activeTaskId: string | null; activeRunId: string | null };
    setTasks(result.tasks);
    setActiveTaskId(result.activeTaskId);
    activeTaskRef.current = result.activeTaskId;
    setActiveRunId(result.activeRunId);
    return result;
  }

  function clearPreview() {
    loadedPreviewRef.current = null;
    window.alpha?.clearPreview();
  }

  function loadPreview(url: string) {
    if (loadedPreviewRef.current === url) return;
    loadedPreviewRef.current = url;
    window.alpha?.loadPreview(url);
  }

  function showTask(task: TaskView, updatePhase = true) {
    selectedTaskRef.current = task.id;
    sessionStorage.setItem("alpha.selectedTask", task.id);
    setTaskId(task.id);
    setCurrentObjective(task.objective);
    setContractVersion(task.contractVersion);
    setPending(task.pending);
    setCriteria(task.criteria);
    setLastFailure(task.lastFailure);
    setReopenReason(task.reopenReason);
    setLatestRun(task.latestRun);
    setEvidence(task.evidence);
    setGuidanceHistory(task.guidanceHistory);
    setAcceptsGuidance(task.acceptsGuidance);
    setScreenshotUrl(task.screenshotUrl);
    setPreview(task.preview?.url ?? null);
    setPreviewLive(task.preview?.live ?? false);
    if (updatePhase) setPhase(task.running ? "运行中" : task.preview && !task.preview.live ? "预览已停止" : statusLabel(task));
    if (!activeTaskRef.current || activeTaskRef.current === task.id) {
      if (task.preview?.live) loadPreview(task.preview.url);
      else clearPreview();
    }
  }

  async function openTask(id: string): Promise<void> {
    selectedTaskRef.current = id;
    const [response, activityResponse, reviewResponse] = await Promise.all([
      fetch(`/api/tasks/${id}`), fetch(`/api/tasks/${id}/activity`), fetch(`/api/tasks/${id}/reviews`),
    ]);
    if (!response.ok) return;
    const result = await response.json() as { task: TaskView };
    const history = activityResponse.ok ? await activityResponse.json() as { entries: ActivityEntry[] } : { entries: [] };
    const reviewList = reviewResponse.ok ? await reviewResponse.json() as { reviews: ReviewSummary[] } : { reviews: [] };
    if (selectedTaskRef.current !== id) return;
    showTask(result.task);
    setActivityEntries(history.entries);
    setReviews(reviewList.reviews);
    setSelectedReview(null);
    setSelectedEvidence(null);
    setBrief(result.task.objective);
    setGuidance("");
    setLiveGuidance("");
    setEntries([]);
    sessionStorage.setItem("alpha.selectedTask", id);
  }

  function newTask() {
    selectedTaskRef.current = null;
    sessionStorage.removeItem("alpha.selectedTask");
    setTaskId(null);
    setCurrentObjective(null);
    setBrief("");
    setGuidance("");
    setPending([]);
    setCriteria([]);
    setLastFailure(null);
    setReopenReason(null);
    setLatestRun(null);
    setEvidence([]);
    setGuidanceHistory([]);
    setAcceptsGuidance(false);
    setActivityEntries([]);
    setReviews([]);
    setSelectedReview(null);
    setSelectedEvidence(null);
    setScreenshotUrl(null);
    setPreview(null);
    setPreviewLive(false);
    setEntries([]);
    setPhase("准备创建任务");
    clearPreview();
  }

  useEffect(() => {
    const socket = new WebSocket(`ws://${location.host}/events`);
    socket.onmessage = event => {
      const message = JSON.parse(event.data) as Message;
      if (message.type === "task") {
        void refreshTasks().catch(() => undefined);
        if (!selectedTaskRef.current || selectedTaskRef.current === message.task.id) showTask(message.task, false);
        return;
      }
      if (message.type === "preview" && message.taskId === activeTaskRef.current) loadPreview(message.url);
      if (message.type !== "control" && (message.taskId ? selectedTaskRef.current !== message.taskId : selectedTaskRef.current !== null)) return;
      if (message.type === "status") {
        setPhase(message.phase);
        if (message.runId && !["待验收", "已验收", "用户接管", "已停止", "失败"].includes(message.phase)) setActiveRunId(message.runId);
        if (message.pending) setPending(message.pending);
        if (["待验收", "已验收", "用户接管", "已停止", "失败"].includes(message.phase)) {
          setBusy(false);
          void refreshTasks().catch(() => undefined);
        }
      } else if (message.type === "text") {
        setEntries(items => {
          const last = items.at(-1);
          return last?.kind === "text"
            ? [...items.slice(0, -1), { kind: "text" as const, value: last.value + message.value }].slice(-200)
            : [...items, { kind: "text" as const, value: message.value }].slice(-200);
        });
      } else if (message.type === "tool") {
        setEntries(items => [...items, { kind: "tool" as const, value: `${message.error ? "✕" : "›"} ${message.name} · ${message.state}` }].slice(-200));
      } else if (message.type === "preview") {
        setPreview(message.url);
        setPreviewLive(true);
        setPending(message.pending);
        loadPreview(message.url);
      } else if (message.type === "control") {
        setControlHolder(message.holder);
      } else {
        setPhase("失败");
        setBusy(false);
        setEntries(items => [...items, { kind: "tool" as const, value: message.message }].slice(-200));
      }
    };
    socket.onerror = () => setPhase("连接中断");
    return () => socket.close();
  }, []);

  useEffect(() => {
    void refreshTasks().then(result => {
      const saved = sessionStorage.getItem("alpha.selectedTask");
      const selected = result.tasks.find(task => task.id === saved)?.id ?? result.activeTaskId ?? result.tasks[0]?.id;
      if (selected) void openTask(selected);
    }).catch(() => undefined);
    void fetch("/api/browser/control").then(response => response.json()).then((result: { holder: "alpha" | "user" }) => setControlHolder(result.holder)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const refresh = () => {
      void refreshTasks().catch(() => undefined);
      if (!taskId) return;
      void fetch(`/api/tasks/${taskId}`).then(response => response.json()).then((result: { task?: TaskView }) => {
        if (result.task && selectedTaskRef.current === result.task.id) showTask(result.task, !result.task.running && !busy);
      }).catch(() => undefined);
      void fetch(`/api/tasks/${taskId}/activity`).then(response => response.json()).then((result: { entries: ActivityEntry[] }) => { if (selectedTaskRef.current === taskId) setActivityEntries(result.entries); }).catch(() => undefined);
      void fetch(`/api/tasks/${taskId}/reviews`).then(response => response.json()).then((result: { reviews: ReviewSummary[] }) => { if (selectedTaskRef.current === taskId) setReviews(result.reviews); }).catch(() => undefined);
    };
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [taskId, busy]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [entries]);

  async function start() {
    if (!brief.trim() || busy || activeRunId || taskId) return;
    setBusy(true);
    setPreview(null);
    clearPreview();
    setPreviewLive(false);
    setTaskId(null);
    setCurrentObjective(null);
    setPending([]);
    setEvidence([]);
    setScreenshotUrl(null);
    setEntries([]);
    setPhase("创建任务");
    const response = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: brief.trim() }) });
    const result = await response.json() as { runId?: string; error?: string };
    if (!response.ok || !result.runId) {
      setBusy(false);
      setPhase("失败");
      setEntries([{ kind: "tool", value: result.error ?? "无法创建任务" }]);
      return;
    }
    setActiveRunId(result.runId);
  }

  async function stop() {
    if (!activeRunId || taskId !== activeTaskId) return;
    await fetch(`/api/tasks/${encodeURIComponent(activeRunId)}/cancel`, { method: "POST" });
    setPhase("停止中");
  }

  async function revise() {
    if (!taskId || !brief.trim() || brief.trim() === currentObjective || busy || activeRunId) return;
    setBusy(true);
    setPhase("修订当前任务");
    const response = await fetch(`/api/tasks/${taskId}/revise`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: brief.trim() }) });
    const result = await response.json() as { runId?: string; error?: string };
    if (!response.ok || !result.runId) {
      setBusy(false);
      setPhase("修订失败");
      setEntries(items => [...items, { kind: "tool", value: result.error ?? "无法修订任务" }]);
      return;
    }
    setActiveRunId(result.runId);
  }

  async function republish() {
    if (!taskId || busy || activeRunId) return;
    setBusy(true);
    setPhase("重新发布本机预览");
    const taskUrl = `/api/tasks/${taskId}`;
    async function checkPreview(): Promise<boolean> {
      const response = await fetch(taskUrl);
      if (!response.ok) throw new Error("无法查询当前预览");
      const result = await response.json() as { task?: TaskView };
      if (!result.task?.preview?.live) return false;
      showTask(result.task);
      return true;
    }
    try {
      if (await checkPreview()) return;
      let rejected = false;
      try {
        const response = await fetch(`${taskUrl}/publish`, { method: "POST" });
        rejected = !response.ok && response.status !== 409;
      } catch {
        // The server may have published even if its reply was lost.
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        if (await checkPreview()) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      setPhase(rejected ? "重新发布失败" : "发布结果未确认，请查询任务状态");
    } catch {
      setPhase("无法查询本机预览状态");
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!taskId || busy || activeRunId) return;
    setBusy(true);
    setPhase("继续修复");
    const response = await fetch(`/api/tasks/${taskId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: guidance.trim() }) });
    const result = await response.json() as { runId?: string; error?: string };
    if (!response.ok || !result.runId) {
      setBusy(false);
      setPhase("继续修复失败");
      setEntries(items => [...items, { kind: "tool", value: result.error ?? "无法继续任务" }]);
      return;
    }
    setGuidance("");
    setActiveRunId(result.runId);
  }

  async function saveGuidance() {
    if (!taskId || occupied || !guidance.trim()) return;
    const response = await fetch(`/api/tasks/${taskId}/guidance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: guidance.trim() }) });
    if (!response.ok) {
      const result = await response.json() as { error?: string };
      setEntries(items => [...items, { kind: "tool", value: result.error ?? "要求未保存" }]);
      return;
    }
    setGuidance("");
    const result = await fetch(`/api/tasks/${taskId}`).then(value => value.json()) as { task: TaskView };
    if (selectedTaskRef.current === taskId) showTask(result.task, false);
  }

  async function sendLiveGuidance() {
    if (!taskId || !acceptsGuidance || !liveGuidance.trim()) return;
    const response = await fetch(`/api/tasks/${taskId}/guidance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: liveGuidance.trim() }) });
    if (!response.ok) {
      const result = await response.json() as { error?: string };
      setEntries(items => [...items, { kind: "tool", value: result.error ?? "补充要求未送达" }]);
      return;
    }
    setLiveGuidance("");
    const result = await fetch(`/api/tasks/${taskId}`).then(value => value.json()) as { task: TaskView };
    if (selectedTaskRef.current === taskId) showTask(result.task, false);
  }

  async function openEvidence(id: string) {
    if (!taskId) return;
    const response = await fetch(`/api/tasks/${taskId}/evidence/${id}`);
    if (!response.ok) { setSelectedEvidence({ id, detail: { content: "证据文件不可用", screenshotUrl: null } }); return; }
    const detail = await response.json() as EvidenceDetail;
    if (selectedTaskRef.current === taskId) setSelectedEvidence({ id, detail });
  }

  async function openReview(id: string) {
    if (!taskId) return;
    const response = await fetch(`/api/tasks/${taskId}/reviews/${id}`);
    if (!response.ok) return;
    const result = await response.json() as { review: ReviewDetail };
    if (selectedTaskRef.current === taskId) setSelectedReview(result.review);
  }

  async function verify() {
    if (!taskId || !previewLive || busy || activeRunId) return;
    setPhase("浏览器验收");
    const response = await fetch(`/api/tasks/${taskId}/verify`, { method: "POST" });
    if (!response.ok) {
      const result = await response.json() as { error?: string };
      setEntries(items => [...items, { kind: "tool", value: result.error ?? "浏览器验收未通过" }]);
    }
  }

  async function toggleControl() {
    const holder = controlHolder === "alpha" ? "user" : "alpha";
    const response = await fetch("/api/browser/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ holder }) });
    if (!response.ok) return;
    setControlHolder(holder);
    if (holder === "alpha" && taskId && previewLive && pending.includes("user-path")) void verify();
  }

  const occupied = busy || activeRunId !== null;
  const selected = tasks.find(task => task.id === taskId);
  const visibleTasks = tasks.filter(task => task.objective.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const criterionLabel = (id: string) => id === "build" ? "产品构建" : id === "user-path" ? "真实浏览器关键路径" : id === "local-preview" ? "本机预览" : criteria.find(item => item.id === id)?.description ?? id;
  const runOutcome = latestRun?.outcome === "returned" ? "已返回" : latestRun?.outcome === "cancelled" ? "已取消" : latestRun?.outcome === "budget" ? "达到预算" : "失败";
  const activityGroups = new Map<string, ActivityEntry[]>();
  for (const entry of activityEntries) {
    const key = entry.operationId ?? entry.id;
    activityGroups.set(key, [...(activityGroups.get(key) ?? []), entry]);
  }
  let evidenceReport: BrowserEvidenceReport | null = null;
  if (selectedEvidence?.detail.content.startsWith("{")) {
    try { evidenceReport = JSON.parse(selectedEvidence.detail.content) as BrowserEvidenceReport; } catch { /* Show raw content below. */ }
  }

  return <main className="shell">
    <aside className="task-nav">
      <header className="brand"><span className="mark">α</span><div><strong>Alpha</strong><small>构建工作台</small></div></header>
      <button className="new-task" onClick={newTask} disabled={occupied}>＋ 新建任务</button>
      <label className="search-label" htmlFor="task-search">任务</label>
      <input id="task-search" className="task-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索任务" />
      <div className="task-list">
        {visibleTasks.length ? visibleTasks.map(task => <button key={task.id} className={`task-item ${task.id === taskId ? "selected" : ""}`} onClick={() => void openTask(task.id)}>
          <span className="task-title" title={task.objective}>{taskTitle(task.objective)}</span>
          <span className="task-meta"><span className={task.running ? "running" : ""}>{statusLabel(task)}</span><time>{new Date(task.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</time></span>
        </button>) : <p className="empty-list">{search ? "没有匹配的任务" : "创建第一个任务后会显示在这里"}</p>}
      </div>
      <footer className="nav-footer">本机项目 · {tasks.length} 个任务</footer>
    </aside>
    <div className="app">
      <header className="workspace-header"><div><small>{taskId ? `任务 · 目标 v${contractVersion}` : "新任务"}</small><h1 title={currentObjective ?? undefined}>{taskId && currentObjective ? taskTitle(currentObjective) : "构建一个新产品"}</h1></div><span className={`status-pill ${selected?.running ? "running" : ""}`}>{taskId && selected ? statusLabel(selected) : "准备就绪"}</span></header>
      {activeRunId && taskId !== activeTaskId && <p className="other-running">另一任务正在运行。可查看当前任务，待运行结束后再发起新操作。</p>}
      <section className="composer panel">
        <label htmlFor="brief">{taskId ? "修改目标" : "想构建什么？"}</label>
        <textarea id="brief" value={brief} onChange={event => setBrief(event.target.value)} placeholder="描述产品、关键交互和验收要求…" rows={taskId ? 3 : 5} />
        <div className="actions">{taskId ? <button className="primary" onClick={revise} disabled={occupied || !brief.trim() || brief.trim() === currentObjective}>应用目标修订</button> : <button className="primary" onClick={start} disabled={occupied || !brief.trim()}>开始构建</button>}{taskId === activeTaskId && activeRunId && <button onClick={stop}>停止本轮</button>}</div>
        {taskId && <p className="hint">修订目标会生成新版本，旧预览与验收证据需要重新核对。</p>}
      </section>
      <section className="state panel"><span className={`dot ${selected?.running ? "working" : ""}`} /><div><small>当前进度</small><strong>{phase}</strong></div>{latestRun && !selected?.running && <span className="run-summary">最近一轮：{runOutcome} · {latestRun.toolCalls} 次工具调用</span>}</section>
      {(lastFailure || reopenReason) && <section className="notice panel"><strong>{lastFailure ? "最近的问题" : "继续原因"}</strong><p>{lastFailure ?? reopenReason}</p></section>}
      {taskId && <section className="checks panel"><h2>验收进度</h2><ul>{criteria.map(item => <li key={item.id}><span className={pending.includes(item.id) ? "check-pending" : "check-pass"}>{pending.includes(item.id) ? "○" : "✓"}</span>{criterionLabel(item.id)}</li>)}<li><span className={pending.includes("local-preview") ? "check-pending" : "check-pass"}>{pending.includes("local-preview") ? "○" : "✓"}</span>本机预览</li></ul>{pending.length > 0 && <p className="hint">待处理：{pending.map(criterionLabel).join(" · ")}</p>}</section>}
      {taskId && pending.length > 0 && <section className="followup panel"><label htmlFor="guidance">继续任务</label><textarea id="guidance" value={guidance} onChange={event => setGuidance(event.target.value)} placeholder="补充修复要求；留空则按当前验收问题继续" rows={2} /><div className="actions"><button onClick={resume} disabled={occupied}>继续修复</button><button onClick={saveGuidance} disabled={occupied || !guidance.trim()}>保存到下轮</button></div></section>}
      {taskId && (acceptsGuidance || guidanceHistory.some(item => item.id)) && <section className="followup panel"><h2>补充要求</h2>{acceptsGuidance && <><textarea aria-label="运行中补充要求" value={liveGuidance} onChange={event => setLiveGuidance(event.target.value)} placeholder="补充当前模型正在执行的要求…" rows={2} /><button onClick={sendLiveGuidance} disabled={!liveGuidance.trim()}>发送给当前任务</button></>}{guidanceHistory.filter(item => item.id).slice(-5).map(item => <p className="guidance-state" key={item.id}><span>{item.status === "processed" ? "已处理" : item.status === "delivered" ? "已投递" : "已记录"}</span> {item.instruction}</p>)}</section>}
      {preview && <section className="delivery panel"><div><strong>本机预览</strong><span>{previewLive ? "运行中" : "已停止"}</span></div><code>{preview}</code>{activeRunId && taskId !== activeTaskId ? <p className="hint">右侧浏览器暂由运行中的任务使用；结束后会切回此任务的预览。</p> : !previewLive && taskId ? <button onClick={republish} disabled={occupied}>重新发布并验收</button> : previewLive && <div className="preview-actions"><button onClick={toggleControl}>{controlHolder === "alpha" ? "接管预览" : "交回 Alpha"}</button>{taskId && !occupied && pending.includes("user-path") && controlHolder === "alpha" && <button onClick={verify}>重新验收</button>}</div>}</section>}
      {evidence.length > 0 && <section className="evidence panel"><h2>验收证据 · {evidence.length} 条</h2><ul>{[...evidence].reverse().map(item => <li key={item.id}><button className="review-link" onClick={() => void openEvidence(item.id)}>{item.passed ? "✓" : "✕"} {criterionLabel(item.criterionId)} · v{item.contractVersion} · {item.current ? "当前版本" : "历史记录"} · {new Date(item.recordedAt).toLocaleString("zh-CN")}</button></li>)}</ul>{selectedEvidence && <div className="evidence-detail"><strong>证据详情</strong>{evidenceReport?.reason && <p className="failure-detail">失败原因：{evidenceReport.reason}</p>}{evidenceReport?.results?.map(step => <p key={step.index}>{step.passed ? "✓" : "✕"} 第 {step.index + 1} 步 · {step.action}{step.detail ? ` · ${step.detail}` : ""}</p>)}{!evidenceReport?.results && <pre>{selectedEvidence.detail.content}</pre>}{selectedEvidence.detail.screenshotUrl && <img src={selectedEvidence.detail.screenshotUrl} alt="所选验收记录的浏览器截图" />}</div>}{!selectedEvidence && screenshotUrl && <img src={screenshotUrl} alt="当前预览的浏览器验收截图" onError={() => setScreenshotUrl(null)} />}</section>}
      {taskId && <section className="activity panel"><h2>任务过程</h2>{activityGroups.size ? [...activityGroups.entries()].reverse().map(([operationId, group]) => <details key={operationId} className="history-run"><summary>{new Date(group[0].recordedAt).toLocaleString("zh-CN")} · 目标 v{group[0].contractVersion} · {group.at(-1)?.value.slice(0, 42)}</summary><div className="history-events">{group.map(item => <p key={item.id}><time>{new Date(item.recordedAt).toLocaleTimeString("zh-CN")}</time><span>{item.kind === "text" ? "模型" : item.kind === "tool" ? "工具" : item.kind === "guidance" ? "用户" : "状态"}</span>{item.value}</p>)}</div></details>) : <p className="muted">此任务创建于历史记录功能之前，或尚未开始执行。可查看已有验收证据。</p>}</section>}
      {taskId && <section className="panel"><h2>源码改动</h2>{reviews.length ? <ul className="review-list">{reviews.map(review => <li key={review.operationId}><button className="review-link" onClick={() => void openReview(review.operationId)}>{new Date(review.recordedAt).toLocaleString("zh-CN")} · 目标 v{review.contractVersion} · {review.paths.length} 个文件</button></li>)}</ul> : <p className="muted">尚无本轮源码快照；旧任务从下一次执行开始记录。</p>}{selectedReview && <div className="review-detail">{selectedReview.changes.length ? selectedReview.changes.map(change => <details key={change.path}><summary>{change.path}</summary><div className="source-compare"><div><strong>修改前</strong><pre>{change.before ?? "（不存在）"}</pre></div><div><strong>修改后</strong><pre>{change.after ?? "（已删除）"}</pre></div></div></details>) : <p className="muted">本轮没有受支持的文本源码改动。</p>}</div>}</section>}
      {(!taskId || selected?.running) && <section className="activity panel"><h2>本次实时事件</h2><div className="log" ref={logRef}>{entries.length ? entries.map((entry, index) => <p key={index}>{entry.value}</p>) : <p className="muted">运行开始后显示当前会话的动作与结果。</p>}</div></section>}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
