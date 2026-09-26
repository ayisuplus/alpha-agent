import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { TaskView } from "../api/types";
import { phaseInfo, taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { loadDraftFiles, saveDraftFiles } from "../state/draft-files";
import { approveTaskPlan, enterPlanning, openTask, resumeTask, reviseTask, sendGuidance, sendTaskMessage, stopTask, store } from "../state/workbench";
import { Button } from "./ui";
import { CapabilityPicker, fileLimitReason } from "./CapabilityPicker";
import { PromptRefine } from "./PromptRefine";
import "./Composer.css";

/** Unsent text per task, so switching tasks does not lose a half-written instruction. */
const drafts = new Map<string, string>();
const attachments = new Map<string, { files: File[]; skillIds: string[]; pluginIds: string[] }>();

type Mode = "steer" | "resume" | "revise" | "blocked" | "plan-review";

export function Composer({ task, phase }: { task: TaskView; phase: string | null }) {
  const pending = useStore(store, state => state.pending);
  const activeTaskId = useStore(store, state => state.activeTaskId);
  const activeRunId = useStore(store, state => state.activeRunId);
  const operation = useStore(store, state => state.operation);
  const defaultModel = useStore(store, state => state.settings?.model.default ?? null);
  const builtinModel = useStore(store, state => state.models?.builtin ?? null);
  const runningTitle = useStore(store, state => {
    const running = state.tasks.find(item => item.id === state.activeTaskId);
    return running ? taskTitle(running) : null;
  });
  const [draft, setDraftState] = useState(() => drafts.get(task.id) ?? localStorage.getItem(`alpha-task-draft-${task.id}`) ?? "");
  const [added, setAddedState] = useState(() => {
    const saved = JSON.parse(localStorage.getItem(`alpha-task-selection-${task.id}`) ?? "null") as { skillIds: string[]; pluginIds: string[] } | null;
    return attachments.get(task.id) ?? { files: [], skillIds: saved?.skillIds ?? task.capabilities?.skills.map(item => item.id) ?? [], pluginIds: saved?.pluginIds ?? task.capabilities?.plugins.map(item => item.id) ?? [] };
  });
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [wantsRevise, setWantsRevise] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  const setDraft = (value: string) => {
    drafts.set(task.id, value);
    localStorage.setItem(`alpha-task-draft-${task.id}`, value);
    setDraftState(value);
  };
  const setAdded = (next: typeof added) => {
    attachments.set(task.id, next);
    localStorage.setItem(`alpha-task-selection-${task.id}`, JSON.stringify({ skillIds: next.skillIds, pluginIds: next.pluginIds }));
    setAddedState(next);
  };
  useEffect(() => {
    let current = true;
    void loadDraftFiles(`task-${task.id}`).then(files => { if (current && !attachments.get(task.id)?.files.length) setAdded({ ...added, files }); }).catch(() => undefined).finally(() => { if (current) setFilesLoaded(true); });
    return () => { current = false; };
  }, [task.id]);
  useEffect(() => { if (filesLoaded) void saveDraftFiles(`task-${task.id}`, added.files).catch(() => undefined); }, [task.id, filesLoaded, added.files]);

  const otherRunning = (activeRunId !== null && activeTaskId !== task.id) || (operation !== null && operation.taskId !== task.id);
  const selfBusy = !task.running && operation !== null && operation.taskId === task.id;
  const mode: Mode = task.running ? "steer" : task.queued || otherRunning || selfBusy ? "blocked" : task.phase === "plan-review" && !wantsRevise ? "plan-review" : task.status === "complete" || wantsRevise ? "revise" : "resume";
  const text = draft.trim();
  const nextVersion = task.contractVersion + 1;
  const readyFiles = !fileLimitReason(added.files, task.inputs);
  const hasAdded = added.files.length > 0 || [...added.skillIds].sort().join("|") !== [...(task.capabilities?.skills.map(item => item.id) ?? [])].sort().join("|") || [...added.pluginIds].sort().join("|") !== [...(task.capabilities?.plugins.map(item => item.id) ?? [])].sort().join("|");
  const canPrimary = !pending && readyFiles && (mode === "steer" ? task.acceptsGuidance && (!!text || !!added.files.length) : mode === "resume" ? task.status !== "needs-input" || !!text || !!added.files.length : mode === "revise" ? !!text && text !== task.objective : mode === "plan-review" ? !!text || !!added.files.length || !!(task.cognition?.steps.length && task.revision) : false);

  const done = (ok: boolean) => {
    if (!ok) return;
    setDraft("");
    setAdded({ ...added, files: [] });
    setWantsRevise(false);
  };

  const primary = async () => {
    if (!canPrimary) return;
    if (mode === "plan-review" && !text && !added.files.length) { done(await approveTaskPlan()); return; }
    if (task.taskType === "general" || hasAdded || mode === "plan-review") {
      done(await sendTaskMessage({ text, files: added.files, ...(task.running ? {} : { skillIds: added.skillIds, pluginIds: added.pluginIds }), forceRevision: mode === "revise" }));
    } else if (mode === "steer" && task.acceptsGuidance && text) done(await sendGuidance(text));
    else if (mode === "resume") done(await resumeTask(text));
    else if (mode === "revise" && text && text !== task.objective) done(await reviseTask(text));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void primary();
    }
  };

  const loadObjective = () => {
    setDraft(task.objective);
    input.current?.focus();
  };

  let placeholder = "";
  let hint: ReactNode = null;
  if (mode === "steer") {
    placeholder = task.acceptsGuidance ? "补充要求，例如“按钮再大一点，文字改成中文”…" : "可以先写好补充要求，模型会话就绪后再发送…";
    hint = task.acceptsGuidance
      ? "补充的要求会立即送达正在工作的 Alpha"
      : `Alpha 正在${phase ? phaseInfo(phase).label : "处理"}，此阶段暂不接收补充要求`;
  } else if (mode === "resume") {
    placeholder = task.phase === "plan" ? "补充规划要求（可以留空）…" : task.status === "needs-input" ? "回答工作台的问题后继续…" : "补充修复要求（可以留空）…";
    hint = task.phase === "plan" ? "继续规划后会重新生成待审计划" : task.status === "needs-input" ? task.pendingQuestion ?? "请回答所需信息" : task.status === "stopped" ? "任务已停止，继续修复会从当前源码接着做" : "留空则按当前的验收问题继续修复";
  } else if (mode === "plan-review") {
    placeholder = "写下对计划的修改意见；留空时可直接批准执行…";
    hint = text || added.files.length ? "发送后会按意见重新规划" : "开始执行会锁定当前目标、计划与源码版本";
  } else if (mode === "revise") {
    placeholder = task.status === "complete" ? "描述想要的修改，例如“再加一个按标题搜索”…" : "写下新的目标…";
    hint = <>提交后生成目标 v{nextVersion}，之前的要求默认保留，{task.taskType === "code-change" ? "变更和检查会重新评估" : "预览和验收会重新进行"}。<button className="link-button" onClick={loadObjective}>载入当前目标全文</button></>;
  } else {
    placeholder = task.queued ? "任务排队中，开始运行后可补充要求…" : "当前无法发送";
    hint = task.queued ? "任务已创建，正在等待前一个任务结束" : otherRunning && activeTaskId && runningTitle
      ? <>「{runningTitle}」正在运行，同一时间只运行一个任务。<button className="link-button" onClick={() => void openTask(activeTaskId)}>查看</button></>
      : `正在${operation ? phaseInfo(operation.phase).label : "处理"}，完成后可以继续`;
  }

  return <div className="composer" data-mode={mode}>
    {(mode === "resume" || mode === "plan-review" || (mode === "revise" && task.status !== "complete")) && <div className="composer-modes" role="tablist" aria-label="下一步">
      <button role="tab" aria-selected={mode === "resume" || mode === "plan-review"} onClick={() => setWantsRevise(false)}>{task.phase === "plan-review" ? "审阅计划" : task.phase === "plan" ? "继续规划" : "继续修复"}</button>
      <button role="tab" aria-selected={mode === "revise"} onClick={() => setWantsRevise(true)}>修订目标</button>
    </div>}
    {mode === "revise" && task.status === "complete" && <div className="composer-modes single"><span>修订目标</span></div>}
    {mode === "steer" && <div className="composer-modes single"><span>运行中补充要求</span></div>}
    <div className="composer-box">
      <textarea
        ref={input}
        id="composer"
        data-testid="composer-input"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={mode === "blocked"}
        aria-label={placeholder}
        rows={2}
      />
      <div className="composer-bar">
        <CapabilityPicker files={added.files} existingFiles={task.inputs} skillIds={added.skillIds} pluginIds={added.pluginIds} direct={task.workspaceOrigin?.kind === "direct"} capabilitiesDisabled={task.running}
          onFiles={files => setAdded({ ...added, files })} onSkills={skillIds => setAdded({ ...added, skillIds })} onPlugins={pluginIds => setAdded({ ...added, pluginIds })} />
        <span className="composer-hint">{hint}</span>
        <PromptRefine value={draft} onApply={setDraft} optimizationModel={task.modelSelector ?? defaultModel ?? builtinModel} disabled={mode === "blocked"} />
        {mode === "steer" && <Button variant="danger" size="sm" icon={Square} onClick={() => void stopTask()} busy={pending === "stop"}>停止</Button>}
        {mode === "resume" && <Button variant="ghost" size="sm" onClick={() => void sendGuidance(text).then(done)} disabled={!text || !!pending} busy={pending === "guidance"} title="只保存，下次继续修复时交给模型">仅保存到下轮</Button>}
        {mode === "steer" && <Button variant="primary" size="sm" icon={ArrowUp} onClick={() => void primary()} disabled={!canPrimary} busy={pending === "guidance"}>发送</Button>}
        {mode === "resume" && (task.phase ?? "execute") === "execute" && task.status !== "needs-input" && <Button variant="ghost" size="sm" onClick={() => void enterPlanning()} disabled={!!pending} busy={pending === "plan"}>先计划</Button>}
        {mode === "resume" && <Button variant="primary" size="sm" onClick={() => void primary()} disabled={!canPrimary} busy={pending === "resume"}>{task.phase === "plan" ? "继续规划" : task.status === "needs-input" ? "提交回答并继续" : "继续修复"}</Button>}
        {mode === "plan-review" && <Button variant="ghost" size="sm" onClick={() => void enterPlanning()} disabled={!!pending} busy={pending === "plan"}>继续规划</Button>}
        {mode === "plan-review" && <Button variant="primary" size="sm" onClick={() => text || added.files.length ? void primary() : void approveTaskPlan()} disabled={!!pending || !readyFiles || (!text && !added.files.length && (!task.cognition?.steps.length || !task.revision))} busy={pending === "approve"}>{text || added.files.length ? "提交意见并重新规划" : "开始执行"}</Button>}
        {mode === "revise" && <Button variant="primary" size="sm" onClick={() => void primary()} disabled={!canPrimary} busy={pending === "revise"}>提交修订 · v{nextVersion}</Button>}
      </div>
    </div>
    <p className="composer-keys"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 发送</p>
  </div>;
}
