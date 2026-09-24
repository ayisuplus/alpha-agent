import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { TaskView } from "../api/types";
import { phaseInfo, taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { openTask, resumeTask, reviseTask, sendGuidance, stopTask, store } from "../state/workbench";
import { Button } from "./ui";
import { PromptRefine } from "./PromptRefine";
import "./Composer.css";

/** Unsent text per task, so switching tasks does not lose a half-written instruction. */
const drafts = new Map<string, string>();

type Mode = "steer" | "resume" | "revise" | "blocked";

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
  const [draft, setDraftState] = useState(() => drafts.get(task.id) ?? "");
  const [wantsRevise, setWantsRevise] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  const setDraft = (value: string) => {
    drafts.set(task.id, value);
    setDraftState(value);
  };

  const otherRunning = (activeRunId !== null && activeTaskId !== task.id) || (operation !== null && operation.taskId !== task.id);
  const selfBusy = !task.running && operation !== null && operation.taskId === task.id;
  const mode: Mode = task.running ? "steer" : otherRunning || selfBusy ? "blocked" : task.status === "complete" || wantsRevise ? "revise" : "resume";
  const text = draft.trim();
  const nextVersion = task.contractVersion + 1;

  const done = (ok: boolean) => {
    if (!ok) return;
    setDraft("");
    setWantsRevise(false);
  };

  const primary = async () => {
    if (pending) return;
    if (mode === "steer" && task.acceptsGuidance && text) done(await sendGuidance(text));
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
    placeholder = task.status === "needs-input" ? "回答工作台的问题后继续…" : "补充修复要求（可以留空）…";
    hint = task.status === "needs-input" ? task.pendingQuestion ?? "请回答所需信息" : task.status === "stopped" ? "任务已停止，继续修复会从当前源码接着做" : "留空则按当前的验收问题继续修复";
  } else if (mode === "revise") {
    placeholder = task.status === "complete" ? "描述想要的修改，例如“再加一个按标题搜索”…" : "写下新的目标…";
    hint = <>提交后生成目标 v{nextVersion}，之前的要求默认保留，{task.taskType === "code-change" ? "变更和检查会重新评估" : "预览和验收会重新进行"}。<button className="link-button" onClick={loadObjective}>载入当前目标全文</button></>;
  } else {
    placeholder = "当前无法发送";
    hint = otherRunning && activeTaskId && runningTitle
      ? <>「{runningTitle}」正在运行，同一时间只运行一个任务。<button className="link-button" onClick={() => void openTask(activeTaskId)}>查看</button></>
      : `正在${operation ? phaseInfo(operation.phase).label : "处理"}，完成后可以继续`;
  }

  return <div className="composer" data-mode={mode}>
    {(mode === "resume" || (mode === "revise" && task.status !== "complete")) && <div className="composer-modes" role="tablist" aria-label="下一步">
      <button role="tab" aria-selected={mode === "resume"} onClick={() => setWantsRevise(false)}>继续修复</button>
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
        <span className="composer-hint">{hint}</span>
        <PromptRefine value={draft} onApply={setDraft} optimizationModel={task.modelSelector ?? defaultModel ?? builtinModel} disabled={mode === "blocked"} />
        {mode === "steer" && <Button variant="danger" size="sm" icon={Square} onClick={() => void stopTask()} busy={pending === "stop"}>停止</Button>}
        {mode === "resume" && <Button variant="ghost" size="sm" onClick={() => void sendGuidance(text).then(done)} disabled={!text || !!pending} busy={pending === "guidance"} title="只保存，下次继续修复时交给模型">仅保存到下轮</Button>}
        {mode === "steer" && <Button variant="primary" size="sm" icon={ArrowUp} onClick={() => void primary()} disabled={!task.acceptsGuidance || !text || !!pending} busy={pending === "guidance"}>发送</Button>}
        {mode === "resume" && <Button variant="primary" size="sm" onClick={() => void primary()} disabled={!!pending || (task.status === "needs-input" && !text)} busy={pending === "resume"}>{task.status === "needs-input" ? "提交回答并继续" : "继续修复"}</Button>}
        {mode === "revise" && <Button variant="primary" size="sm" onClick={() => void primary()} disabled={!text || text === task.objective || !!pending} busy={pending === "revise"}>提交修订 · v{nextVersion}</Button>}
      </div>
    </div>
    <p className="composer-keys"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 发送</p>
  </div>;
}
