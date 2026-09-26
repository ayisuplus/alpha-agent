import { useMemo } from "react";
import type { TaskView } from "../api/types";
import { Composer } from "../components/Composer";
import { ApplyCodePanel } from "../components/ApplyCodePanel";
import { DiffView } from "../components/DiffView";
import { EvidenceView } from "../components/EvidenceView";
import { NewTask } from "../components/NewTask";
import { OfficePdfPreview } from "../components/OfficePdfPreview";
import { SettingsView } from "../components/settings/SettingsView";
import { ThreadHeader } from "../components/ThreadHeader";
import { Timeline } from "../components/Timeline";
import { Spinner } from "../components/ui";
import { useStore } from "../state/store";
import { attachLiveText, buildTimeline, livePhase } from "../state/timeline";
import { openDetail, store, type Detail } from "../state/workbench";
import "./Thread.css";

export function TaskDetail({ task, detail, onBack }: { task: TaskView; detail: Detail; onBack(): void }) {
  if (detail.kind === "diff") return <DiffView taskId={task.id} operationId={detail.operationId} onBack={onBack} />;
  if (detail.kind === "info") return <ThreadHeader task={task} busy={task.running} phase={null} detailsOnly onBack={onBack} />;
  return <EvidenceView key={`${detail.criterionId}:${detail.evidenceId}`} task={task} criterionId={detail.criterionId} evidenceId={detail.evidenceId} onBack={onBack} />;
}

function TaskThread({ task }: { task: TaskView }) {
  const activity = useStore(store, state => state.activity);
  const reviews = useStore(store, state => state.reviews);
  const liveText = useStore(store, state => state.liveText);
  const operation = useStore(store, state => state.operation);
  const detail = useStore(store, state => state.detail);
  const workspaceView = useStore(store, state => state.workspaceView);

  const busy = task.running || operation?.taskId === task.id;
  const items = useMemo(() => buildTimeline({ task, activity, reviews, busy }), [task, activity, reviews, busy]);
  const withLive = useMemo(() => attachLiveText(items, liveText, busy, new Date().toISOString()), [items, liveText, busy]);
  const phase = (operation?.taskId === task.id ? operation.phase : null) ?? livePhase(items);
  const back = () => openDetail(null);
  const artifacts = task.status === "complete" ? task.evidence.filter(item => item.kind === "artifact" && item.contractVersion === task.contractVersion && item.revision === task.revision) : [];

  return <>
    <ThreadHeader key={task.id} task={task} busy={busy} phase={phase} />
    <ApplyCodePanel task={task} />
    <Timeline items={withLive} task={task} />
    {!!artifacts.length && <section className="task-results" aria-label="本次成果"><h2>已完成的成果</h2>{artifacts.filter(item => !/[0-9a-f-]{36}-(?:before|preview)\.pdf$/i.test(item.source)).map(item => {
      const name = item.source.split(/[\\/]/).at(-1) ?? "成果文件";
      const url = `/api/tasks/${task.id}/artifacts/${item.id}`;
      const openable = /\.(pdf|png|jpe?g|txt)$/i.test(name);
      const officeId = /^([0-9a-f-]{36})-/.exec(name)?.[1];
      const preview = artifacts.find(candidate => candidate.source.split(/[\\/]/).at(-1) === `${officeId}-preview.pdf`);
      const before = artifacts.find(candidate => candidate.source.split(/[\\/]/).at(-1) === `${officeId}-before.pdf`);
      const afterUrl = preview ? `/api/tasks/${task.id}/artifacts/${preview.id}` : /\.pdf$/i.test(name) ? url : null;
      return <div className="task-result" key={item.id}><div className="task-result-file"><strong>{name}</strong>{openable && <a href={`${url}?inline=1`} target="_blank" rel="noreferrer">打开</a>}<a href={url} download={name}>下载</a></div>{afterUrl && <details><summary>查看页面预览</summary><div className="office-preview-grid">{before && <OfficePdfPreview url={`/api/tasks/${task.id}/artifacts/${before.id}`} label="修改前" />}<OfficePdfPreview url={afterUrl} label="修改后" /></div></details>}</div>;
    })}</section>}
    <Composer key={task.id} task={task} phase={phase} />
    {detail && workspaceView === "preview" && <div className="task-detail-overlay" role="dialog" aria-label="审阅详情">
      <TaskDetail task={task} detail={detail} onBack={back} />
    </div>}
  </>;
}

export function Thread() {
  const selectedId = useStore(store, state => state.selectedId);
  const task = useStore(store, state => state.task);
  const panel = useStore(store, state => state.panel);
  if (panel?.kind === "settings") return <SettingsView section={panel.section} />;
  if (selectedId === null) return <NewTask />;
  if (!task || task.id !== selectedId) return <p className="thread-loading"><Spinner size={16} />正在加载任务…</p>;
  return <TaskThread task={task} />;
}
