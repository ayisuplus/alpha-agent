import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { CommandApproval, TaskView } from "../api/types";
import { resumeTask } from "../state/workbench";
import "./ApplyCodePanel.css";

type Review = Awaited<ReturnType<typeof api.applyReview>>;

export function ApplyCodePanel({ task }: { task: TaskView }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [approvals, setApprovals] = useState<CommandApproval[]>([]);
  const [decisionStatus, setDecisionStatus] = useState<string | null>(null);
  useEffect(() => {
    if (task.taskType !== "code-change" && task.taskType !== "general") return;
    let live = true;
    if (task.taskType === "code-change" && task.workspaceOrigin?.kind !== "direct") void api.applyReview(task.id).then(value => { if (live) { setReview(value); setError(null); } }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    void api.approvals(task.id).then(value => { if (live) setApprovals(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [task.id, task.revision, task.status, task.taskType]);
  if (task.taskType !== "code-change" && task.taskType !== "general") return null;
  const apply = async () => {
    if (!review?.revision || review.conflicts.length || busy) return;
    setBusy(true);
    try {
      await api.applyCode(task.id, review.revision);
      setApplied(true);
      setReview(await api.applyReview(task.id));
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const decide = async (request: CommandApproval, approved: boolean) => {
    try {
      await api.decideApproval(task.id, request.id, approved);
      setApprovals(await api.approvals(task.id));
      if (approved && (task.status === "needs-input" || task.status === "stopped")) {
        setDecisionStatus("批准已记录，正在继续任务…");
        setDecisionStatus(await resumeTask("按已批准的操作继续执行", task.id) ? "批准已记录，任务已继续" : "批准已记录，但任务尚未继续；请在输入框点击继续");
      } else setDecisionStatus(approved ? "批准已记录，任务正在运行" : "操作已拒绝；任务未继续");
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="code-apply-panel" aria-label="应用代码变更">
    <details open={approvals.some(request => request.status === "pending") ? true : undefined}>
    <summary>{task.workspaceOrigin?.kind === "direct" ? "项目操作审批" : "原项目应用审阅"}{approvals.some(request => request.status === "pending") ? " · 待你处理" : ""}</summary>
    {task.workspaceOrigin?.kind !== "direct" && <p>原目录：{task.workspaceOrigin?.sourcePath ?? "未知"}</p>}
    {!!approvals.length && <div className="code-approvals"><strong>操作审批</strong>{approvals.map(request => <div key={request.id}>
      <code>{JSON.stringify(request.argv)}</code><span> · {request.exactAction ? "文件" : request.purpose === "check" ? "检查" : "命令"}{request.network ? " · 联网" : ""} · {request.risk ?? "normal"} · {request.status}</span>
      {request.reason && <p>{request.reason}</p>}
      {request.scriptCommand && <p>项目脚本：<code>{request.scriptCommand}</code></p>}
      {request.review && <p>{request.review.reviewer}：{request.review.decision} · {request.review.reason}</p>}
      {request.exactAction && <details><summary>查看精确动作</summary><pre>{JSON.stringify(request.exactAction, null, 2)}</pre></details>}
      {request.status === "pending" && <><button type="button" onClick={() => void decide(request, true)}>批准</button><button type="button" onClick={() => void decide(request, false)}>拒绝</button></>}
    </div>)}</div>}
    {review && <>
      <ul>{review.changes.map(change => <li key={change.path}>{change.action} · {change.path}{change.conflict ? " · 原文件已变化" : ""}</li>)}</ul>
      {!review.changes.length && <p>{applied ? "变更已应用到原项目。" : "当前没有可应用的变更。"}</p>}
      {!!review.conflicts.length && <p role="alert">检测到冲突，已停止应用：{review.conflicts.join("、")}</p>}
      {task.status === "complete" && !!review.changes.length && !review.conflicts.length && <button type="button" disabled={busy} onClick={() => void apply()}>{busy ? "应用中…" : "应用已审阅变更到原项目"}</button>}
    </>}
    {error && <p role="alert">{error}</p>}
    {decisionStatus && <p role="status">{decisionStatus}</p>}
    </details>
  </section>;
}
