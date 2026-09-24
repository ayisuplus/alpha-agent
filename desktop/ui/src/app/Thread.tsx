import { useMemo } from "react";
import type { TaskView } from "../api/types";
import { Composer } from "../components/Composer";
import { ApplyCodePanel } from "../components/ApplyCodePanel";
import { TaskAutomationPanel } from "../components/TaskAutomationPanel";
import { DiffView } from "../components/DiffView";
import { EvidenceView } from "../components/EvidenceView";
import { NewTask } from "../components/NewTask";
import { SettingsView } from "../components/settings/SettingsView";
import { ThreadHeader } from "../components/ThreadHeader";
import { Timeline } from "../components/Timeline";
import { Spinner } from "../components/ui";
import { useStore } from "../state/store";
import { attachLiveText, buildTimeline, livePhase } from "../state/timeline";
import { openDetail, store } from "../state/workbench";

function TaskThread({ task }: { task: TaskView }) {
  const activity = useStore(store, state => state.activity);
  const reviews = useStore(store, state => state.reviews);
  const liveText = useStore(store, state => state.liveText);
  const operation = useStore(store, state => state.operation);
  const detail = useStore(store, state => state.detail);

  const busy = task.running || operation?.taskId === task.id;
  const items = useMemo(() => buildTimeline({ task, activity, reviews, busy }), [task, activity, reviews, busy]);
  const withLive = useMemo(() => attachLiveText(items, liveText, busy, new Date().toISOString()), [items, liveText, busy]);
  const phase = (operation?.taskId === task.id ? operation.phase : null) ?? livePhase(items);
  const back = () => openDetail(null);

  return <>
    <ThreadHeader task={task} busy={busy} phase={phase} compact={!!detail} />
    {detail?.kind === "diff" && <DiffView taskId={task.id} operationId={detail.operationId} onBack={back} />}
    {detail?.kind === "evidence" && <EvidenceView key={`${detail.criterionId}:${detail.evidenceId}`} task={task} criterionId={detail.criterionId} evidenceId={detail.evidenceId} onBack={back} />}
    {!detail && <>
      <ApplyCodePanel task={task} />
      <TaskAutomationPanel task={task} />
      <Timeline items={withLive} task={task} />
      <Composer key={task.id} task={task} phase={phase} />
    </>}
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
