import { useState } from "react";
import { ChevronDown, CircleAlert, Info, MoreHorizontal } from "lucide-react";
import type { TaskView } from "../api/types";
import { criterionState, describeStep, parseFailure } from "../state/evidence";
import { criterionLabel, failureHeadline, formatDateTime, phaseInfo, reopenText, taskStatus, taskTitle } from "../state/labels";
import { openDetail, openSettings, setTaskModel } from "../state/workbench";
import { ModelPicker } from "./ModelPicker";
import { TaskMenu } from "./TaskMenu";
import { Badge, IconButton, Spinner, StateIcon } from "./ui";
import "./ThreadHeader.css";

function FailureAlert({ reason }: { reason: string }) {
  const [expanded, setExpanded] = useState(false);
  const failure = parseFailure(reason);
  const detail = failure
    ? `第 ${failure.step}/${failure.total} 步${failure.spec ? `（${describeStep(failure.spec)}）` : ""}失败：${failure.message}`
    : reason;
  const verification = !!failure || /verification|browser|preview/i.test(reason);
  const modelProblem = /Authenticated model is unavailable|no response within/i.test(reason);
  return <div className="thread-alert tone-danger" role="status">
    <CircleAlert size={16} aria-hidden />
    <div className="thread-alert-body">
      <strong>{failureHeadline(reason)}</strong>
      <p className={expanded ? "" : "clamped"}>{detail}</p>
    </div>
    <div className="thread-alert-actions">
      {detail.length > 140 && <button className="link-button" onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}</button>}
      {verification && <button className="link-button" onClick={() => openDetail({ kind: "evidence", criterionId: "user-path" })}>查看证据</button>}
      {modelProblem && <button className="link-button" onClick={() => openSettings("model")}>模型设置</button>}
    </div>
  </div>;
}

export function ThreadHeader({ task, busy, phase, compact }: { task: TaskView; busy: boolean; phase: string | null; compact?: boolean }) {
  const [showObjective, setShowObjective] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const status = taskStatus(task);
  const criteria = [...task.criteria.map(item => item.id).filter(id => id !== "local-preview"), ...(!task.taskType || task.taskType === "web-product" ? ["local-preview"] : [])];
  const history = [...(task.contractHistory ?? [])].sort((a, b) => b.version - a.version);

  return <header className="thread-header">
    <div className="thread-title-row">
      <h1 title={task.objective}>{taskTitle(task)}</h1>
      <span aria-live="polite">
        {busy
          ? <Badge tone="accent"><Spinner size={12} />{phase ? `运行中 · ${phaseInfo(phase).label}` : "运行中"}</Badge>
          : <Badge tone={status.tone}>{status.label}</Badge>}
      </span>
      <div className="task-menu-anchor">
        <IconButton icon={MoreHorizontal} label="任务操作" onClick={() => setMenuOpen(value => !value)} />
        <TaskMenu task={task} open={menuOpen} onClose={() => setMenuOpen(false)} />
      </div>
    </div>
    <div className="thread-meta">
      <button className="objective-toggle" aria-expanded={showObjective} onClick={() => setShowObjective(value => !value)}>
        目标 v{task.contractVersion}<ChevronDown size={14} aria-hidden />
      </button>
      <ModelPicker value={task.modelSelector ?? null} allowDefault onChange={async value => {
        setModelSaving(true);
        try { await setTaskModel(value); } finally { setModelSaving(false); }
      }} label="这个任务的模型" disabled={busy || modelSaving}
        disabledReason={modelSaving ? "正在保存模型" : "任务运行中，结束后才能更换模型"} />
      {task.createdAt && <span>创建于 {formatDateTime(task.createdAt)}</span>}
      <span>更新于 {formatDateTime(task.updatedAt)}</span>
    </div>
    {showObjective && <div className="objective-panel">
      <div className="objective-version current">
        <span className="objective-label">当前目标 · v{task.contractVersion}</span>
        <p>{task.objective}</p>
      </div>
      {history.map(item => <div key={item.version} className="objective-version">
        <span className="objective-label">v{item.version} · 修订于 {formatDateTime(item.revisedAt)}</span>
        <p>{item.objective}</p>
      </div>)}
      {!!task.inputs?.length && <div className="objective-version"><span className="objective-label">输入文件</span>{task.inputs.map(item => <p key={item.id}><a href={item.url} download>{item.name}</a> · SHA-256 {item.sha256.slice(0, 12)}…</p>)}</div>}
    </div>}
    <div className="criteria-row" aria-label="验收进度">
      {criteria.map(id => {
        const state = criterionState(id, task.pending, task.evidence);
        return <button key={id} className={`criterion state-${state}`} onClick={() => openDetail({ kind: "evidence", criterionId: id })} title="查看验收证据">
          <StateIcon state={state} size={13} />{criterionLabel(id, task.criteria)}
        </button>;
      })}
    </div>
    {!compact && task.lastFailure && task.status !== "complete" && !busy && <FailureAlert reason={task.lastFailure} />}
    {!compact && !task.lastFailure && task.reopenReason && task.status === "active" && !busy && <div className="thread-alert tone-info">
      <Info size={16} aria-hidden />
      <div className="thread-alert-body"><p>{reopenText(task.reopenReason)}</p></div>
    </div>}
  </header>;
}
