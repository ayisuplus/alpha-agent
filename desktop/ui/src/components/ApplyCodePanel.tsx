import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { CommandApproval, TaskView } from "../api/types";
import "./ApplyCodePanel.css";

type Review = Awaited<ReturnType<typeof api.applyReview>>;

export function ApplyCodePanel({ task }: { task: TaskView }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [approvals, setApprovals] = useState<CommandApproval[]>([]);
  useEffect(() => {
    if (task.taskType !== "code-change") return;
    let live = true;
    void api.applyReview(task.id).then(value => { if (live) { setReview(value); setError(null); } }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    void api.approvals(task.id).then(value => { if (live) setApprovals(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [task.id, task.revision, task.taskType]);
  if (task.taskType !== "code-change") return null;
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
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="code-apply-panel" aria-label="应用代码变更">
    <strong>原项目应用审阅</strong>
    <p>原目录：{task.workspaceOrigin?.sourcePath ?? "未知"}</p>
    {!!approvals.length && <div className="code-approvals"><strong>命令审批</strong>{approvals.map(request => <div key={request.id}>
      <code>{JSON.stringify(request.argv)}</code><span> · {request.purpose === "check" ? "检查" : "其它命令"} · {request.status}</span>
      {request.status === "pending" && <><button type="button" onClick={() => void decide(request, true)}>批准</button><button type="button" onClick={() => void decide(request, false)}>拒绝</button></>}
    </div>)}</div>}
    {review && <>
      <ul>{review.changes.map(change => <li key={change.path}>{change.action} · {change.path}{change.conflict ? " · 原文件已变化" : ""}</li>)}</ul>
      {!review.changes.length && <p>{applied ? "变更已应用到原项目。" : "当前没有可应用的变更。"}</p>}
      {!!review.conflicts.length && <p role="alert">检测到冲突，已停止应用：{review.conflicts.join("、")}</p>}
      {task.status === "complete" && !!review.changes.length && !review.conflicts.length && <button type="button" disabled={busy} onClick={() => void apply()}>{busy ? "应用中…" : "应用已审阅变更到原项目"}</button>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
