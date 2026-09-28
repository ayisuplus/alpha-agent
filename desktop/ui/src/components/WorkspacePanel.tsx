import { useEffect, useState } from "react";
import { ClipboardCheck, Globe, PanelRightClose, SquareTerminal } from "lucide-react";
import { api } from "../api/client";
import type { EvidenceItem, TaskView } from "../api/types";
import { TaskDetail } from "../app/Thread";
import { BrowserPane } from "./BrowserPane";
import { criterionLabel } from "../state/labels";
import { useStore } from "../state/store";
import { closePanel, closeWorkspace, openDetail, showPreview, showReview, showTerminal, store } from "../state/workbench";
import "./WorkspacePanel.css";

const tabs = [
  { id: "detail", label: "审查", icon: ClipboardCheck, action: showReview },
  { id: "terminal", label: "运行日志", icon: SquareTerminal, action: showTerminal },
  { id: "preview", label: "浏览器", icon: Globe, action: showPreview },
] as const;

export function WorkspaceRail() {
  // Opening a workspace view from settings or automations returns to the task it belongs to.
  const open = (action: () => void) => { if (store.get().panel) closePanel(); action(); };
  return <aside className="workspace-rail" aria-label="右侧工作区">
    {tabs.map(({ id, label, icon: Icon, action }) => <button key={id} aria-label={`打开${label}栏`} title={label} onClick={() => open(action)}>
      <Icon size={17} aria-hidden /><span>{label}</span>
    </button>)}
  </aside>;
}

function ReviewHome({ task }: { task: TaskView | null }) {
  const reviews = useStore(store, state => state.reviews);
  if (!task) return <p className="workspace-empty">选择任务后，可以在这里审查改动和验收证据。</p>;
  const latest = reviews.at(-1);
  return <div className="review-home">
    <button className="review-link" onClick={() => openDetail({ kind: "info" })}>任务详情 <span>目标、状态和计划 →</span></button>
    <h3>源码改动</h3>
    {latest ? <button className="review-link" onClick={() => openDetail({ kind: "diff", operationId: latest.operationId })}>
      本轮改动 <span>{latest.paths.length} 个文件 →</span>
    </button> : <p className="review-muted">还没有可审查的源码改动。</p>}
    <h3>验收证据</h3>
    {task.criteria.length ? task.criteria.map(criterion => {
      const evidence = task.evidence.findLast(item => item.criterionId === criterion.id && item.current);
      return <button className="review-link" key={criterion.id} onClick={() => openDetail({ kind: "evidence", criterionId: criterion.id, evidenceId: evidence?.id })}>
        {criterionLabel(criterion.id, task.criteria)}<span>{evidence ? evidence.passed ? "已通过" : "未通过" : "待验收"} →</span>
      </button>;
    }) : <p className="review-muted">这个任务没有单列的验收项。</p>}
  </div>;
}

function TerminalPane({ task }: { task: TaskView | null }) {
  const activity = useStore(store, state => state.activity);
  const logs = task?.evidence.filter(item => item.kind === "build" || item.kind === "test" || item.criterionId === "build" || item.criterionId === "check") ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected: EvidenceItem | undefined = logs.find(item => item.id === selectedId) ?? logs.at(-1);
  const [content, setContent] = useState<{ key: string; text: string } | null>(null);
  const key = task && selected ? `${task.id}:${selected.id}` : "";
  useEffect(() => {
    if (!task || !selected) return;
    let current = true;
    void api.evidence(task.id, selected.id).then(result => {
      if (current) setContent({ key, text: result.content });
    }).catch(error => { if (current) setContent({ key, text: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [key]);
  const recent = activity.filter(item => item.kind === "tool" || item.kind === "error").slice(-80);
  return <div className="terminal-pane">
    <header><h2>运行日志</h2><span>只读运行记录</span></header>
    {!task ? <p className="workspace-empty">选择任务后，可以查看命令过程和构建输出。</p> : <>
      {logs.length > 0 && <label className="terminal-log-picker">构建与检查日志
        <select value={selected?.id ?? ""} onChange={event => setSelectedId(event.target.value)}>
          {[...logs].reverse().map(item => <option key={item.id} value={item.id}>{item.criterionId} · {item.passed ? "通过" : "未通过"} · {new Date(item.recordedAt).toLocaleString("zh-CN")}</option>)}
        </select>
      </label>}
      {selected && <pre className="terminal-output">{content?.key === key ? content.text : "正在读取日志…"}</pre>}
      <h3>最近工具活动</h3>
      {recent.length ? <pre className="terminal-output terminal-activity">{recent.map(item => `${new Date(item.recordedAt).toLocaleTimeString("zh-CN")}  ${item.error ? "!" : ">"} ${item.value}${item.target ? ` · ${item.target}` : ""}`).join("\n")}</pre>
        : <p className="review-muted">还没有命令或工具活动。</p>}
      <p className="terminal-note">这里展示任务已记录的输出；当前版本不接受交互式命令。</p>
    </>}
  </div>;
}

export function WorkspacePanel({ layoutKey, locked }: { layoutKey: string; locked: boolean }) {
  const view = useStore(store, state => state.workspaceView);
  const detail = useStore(store, state => state.detail);
  const task = useStore(store, state => state.task);
  return <aside className="workspace-panel" aria-label="右侧工作区">
    <header className="workspace-tabs" role="tablist" aria-label="工作区视图">
      {tabs.map(({ id, label, icon: Icon, action }) => <button key={id} role="tab" aria-selected={view === id} onClick={action}>
        <Icon size={15} aria-hidden />{label}
      </button>)}
      <button className="workspace-collapse" aria-label="收起右侧栏" title={locked && view === "preview" ? "浏览器正在使用预览" : "收起右侧栏"} disabled={locked && view === "preview"} onClick={closeWorkspace}><PanelRightClose size={15} aria-hidden /></button>
    </header>
    <div className="workspace-panel-body">
      {view === "preview" && <BrowserPane locked={locked} layoutKey={layoutKey} />}
      {view === "detail" && (detail && task ? <TaskDetail task={task} detail={detail} onBack={showReview} /> : <ReviewHome task={task} />)}
      {view === "terminal" && <TerminalPane task={task} />}
    </div>
  </aside>;
}
