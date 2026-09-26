import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { TaskView, WebApproval, WebJob, WebSource, WebTab } from "../api/types";
import { notify, resumeTask, selectBrowserTab, syncSelected } from "../state/workbench";
import { Button } from "./ui";
import "./WebPanel.css";

export function WebPanel({ task }: { task: TaskView }) {
  const [approvals, setApprovals] = useState<WebApproval[]>([]);
  const [tabs, setTabs] = useState<WebTab[]>([]);
  const [sources, setSources] = useState<WebSource[]>([]);
  const [jobs, setJobs] = useState<WebJob[]>([]);
  const [url, setUrl] = useState("https://github.com");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [nextApprovals, nextTabs, nextSources] = await Promise.all([api.webApprovals(task.id), api.webTabs(task.id), api.webSources(task.id)]);
    setApprovals(nextApprovals); setTabs(nextTabs); setSources(nextSources.sources); setJobs(nextSources.jobs);
  };
  useEffect(() => { void refresh().catch(error => notify(error instanceof Error ? error.message : String(error))); }, [task.id, task.updatedAt]);
  const operate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const decide = (approval: WebApproval, approved: boolean) => operate(async () => {
    await api.decideWebApproval(task.id, approval.id, approved);
    await syncSelected(task.id);
    if (approved && task.status === "needs-input") await resumeTask("", task.id);
  });

  return <details className="web-panel" data-pending={approvals.some(item => item.status === "pending") || undefined}>
    <summary>网页工作 · {tabs.length} 个页面 · {sources.length} 个来源{approvals.some(item => item.status === "pending") ? " · 待授权" : ""}</summary>
    <div className="web-panel-body">
      <div className="web-panel-row">
        <input aria-label="打开网页地址" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com" />
        <Button size="sm" disabled={busy} onClick={() => void operate(async () => { const tab = await api.openWebTab(task.id, url.trim()); selectBrowserTab(tab.tabId); })}>在 Alpha 浏览器打开</Button>
        <Button size="sm" disabled={busy} onClick={() => void operate(refresh)}>刷新</Button>
      </div>
      {!!approvals.length && <section><strong>网页权限与动作回执</strong>{approvals.map(item => <div className="web-panel-item" key={item.id}>
        <span>{item.kind === "read" ? "读取" : "外部动作"} · {item.details ?? item.scope} · {item.status}</span>
        {item.status === "pending" && <span className="web-panel-actions"><Button size="sm" disabled={busy} onClick={() => void decide(item, true)}>批准</Button><Button size="sm" variant="danger" disabled={busy} onClick={() => void decide(item, false)}>拒绝</Button></span>}
      </div>)}</section>}
      {!!tabs.length && <section><strong>当前页面</strong>{tabs.map(tab => <div className="web-panel-item" key={tab.tabId}>
        <span title={tab.url}>{tab.title || tab.url} <small>{tab.url}</small></span>
        <span className="web-panel-actions"><Button size="sm" disabled={busy} onClick={() => void operate(async () => { await api.webTabAction(task.id, tab.tabId, "focus"); selectBrowserTab(tab.tabId); })}>显示</Button><Button size="sm" disabled={busy} onClick={() => void operate(() => api.webTabAction(task.id, tab.tabId, "close"))}>关闭</Button></span>
      </div>)}</section>}
      {!!jobs.length && <section><strong>采集作业</strong>{jobs.map(job => <p key={job.id}>{job.url} · {job.status}{job.cancelRequested ? " · 已请求取消" : ""}{job.pages !== undefined ? ` · ${job.pages} 页` : ""}</p>)}</section>}
      {!!sources.length && <section><strong>已归档来源</strong>{sources.map(source => <details key={source.id} className="web-panel-source"><summary>{source.title} · {source.kind ?? "旧来源"}</summary><p>{source.url} · {source.visitedAt}</p><p>来源 ID {source.id} · 正文 SHA-256 {source.sha256} · 原始材料 SHA-256 {source.rawSha256}</p><pre>{source.text.slice(0, 4_000)}</pre></details>)}</section>}
    </div>
  </details>;
}
