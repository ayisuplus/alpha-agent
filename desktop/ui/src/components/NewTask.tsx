import { useEffect, useState, type KeyboardEvent } from "react";
import { CircleAlert } from "lucide-react";
import { taskTitle } from "../state/labels";
import { newTaskDraft } from "../state/new-task-draft";
import { loadDraftFiles, saveDraftFiles } from "../state/draft-files";
import { useStore } from "../state/store";
import { clearStarting, openSettings, openTask, startGeneralTask, store } from "../state/workbench";
import { CapabilityPicker, fileLimitReason } from "./CapabilityPicker";
import { ModelPicker } from "./ModelPicker";
import { PromptRefine } from "./PromptRefine";
import { Button, Spinner } from "./ui";
import "./NewTask.css";

let savedDraft = localStorage.getItem("alpha-new-task-draft") ?? "";
let savedModel: string | null = null;

export function NewTask() {
  const starting = useStore(store, state => state.starting);
  const pending = useStore(store, state => state.pending);
  const activeTaskId = useStore(store, state => state.activeTaskId);
  const busy = useStore(store, state => state.activeRunId !== null || state.operation !== null);
  const catalog = useStore(store, state => state.models);
  const defaultModel = useStore(store, state => state.settings?.model.default ?? null);
  const projects = useStore(store, state => state.projects);
  const draftConfig = useStore(newTaskDraft, state => state);
  const runningTitle = useStore(store, state => {
    const running = state.tasks.find(item => item.id === state.activeTaskId);
    return running ? taskTitle(running) : null;
  });
  const [draft, setDraftState] = useState(() => starting?.brief ?? savedDraft);
  const [model, setModelState] = useState<string | null>(savedModel);
  const [filesLoaded, setFilesLoaded] = useState(false);
  useEffect(() => {
    let current = true;
    void loadDraftFiles("new-task").then(files => { if (current && !newTaskDraft.get().files.length) newTaskDraft.set({ files }); }).catch(() => undefined).finally(() => { if (current) setFilesLoaded(true); });
    return () => { current = false; };
  }, []);
  useEffect(() => { if (filesLoaded) void saveDraftFiles("new-task", draftConfig.files).catch(() => undefined); }, [filesLoaded, draftConfig.files]);
  const setDraft = (value: string) => { savedDraft = value; localStorage.setItem("alpha-new-task-draft", value); setDraftState(value); };
  const setModel = (value: string | null) => { savedModel = value; setModelState(value); };
  const selectedProject = projects.find(item => item.id === draftConfig.projectId);
  const selectedMount = selectedProject?.mounts.find(item => item.id === draftConfig.mountId);
  const selectedModel = model ?? defaultModel ?? catalog?.builtin;
  const modelReady = !!catalog?.models.some(item => item.selector === selectedModel && item.available);
  const text = draft.trim();
  const projectReady = !selectedProject?.mounts.length || !!selectedMount;
  const filesReady = !fileLimitReason(draftConfig.files);
  const capabilityReady = !selectedMount || !draftConfig.pluginIds.length;

  if (starting && !starting.error) return <div className="new-task starting" data-testid="new-task">
    <div className="user-message"><div className="user-message-meta"><span>目标</span></div><div className="user-message-bubble">{starting.brief}</div></div>
    <p className="new-task-starting"><Spinner size={14} />正在创建任务并启动 Alpha…</p>
  </div>;

  const canSubmit = !!text && !pending && modelReady && projectReady && filesReady && capabilityReady;
  const submit = () => {
    if (!canSubmit) return;
    void startGeneralTask({ objective: text, projectId: selectedProject?.id ?? "", mountId: selectedMount?.id ?? "",
      files: draftConfig.files, skillIds: draftConfig.skillIds, pluginIds: draftConfig.pluginIds,
      model, startMode: draftConfig.startMode, continueUntilAccepted: draftConfig.continueUntilAccepted }).then(() => {
      if (!store.get().starting?.error) {
        setDraft(""); savedModel = null;
        newTaskDraft.set({ files: [], skillIds: [], pluginIds: [] });
      }
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  };

  return <div className="new-task" data-testid="new-task">
    <div className="new-task-hero"><span className="new-task-mark" aria-hidden>α</span><h1>想让 Alpha 完成什么？</h1></div>
    <p className="new-task-context" aria-label="当前任务上下文">
      <strong>{selectedProject?.name ?? "临时工作区"}</strong><span>·</span><span title={selectedMount?.path}>{selectedMount?.path ?? (selectedProject?.mounts.length ? "请在左侧选择主工作目录" : "Alpha 管理的工作区")}</span>
    </p>
    {starting?.error && <div className="thread-alert tone-danger" role="alert"><CircleAlert size={16} aria-hidden /><div className="thread-alert-body"><strong>任务没有启动</strong><p>{starting.error}</p></div><div className="thread-alert-actions"><button className="link-button" onClick={clearStarting}>关闭</button></div></div>}
    <div className="composer-box new-task-box">
      <textarea id="brief" data-testid="brief" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown}
        placeholder="描述你要解决的问题、使用的材料和期望结果…" aria-label="描述任务目标" rows={5} />
      <div className="composer-bar">
        <CapabilityPicker files={draftConfig.files} skillIds={draftConfig.skillIds} pluginIds={draftConfig.pluginIds} direct={!!selectedMount}
          onFiles={files => newTaskDraft.set({ files })} onSkills={skillIds => newTaskDraft.set({ skillIds })} onPlugins={pluginIds => newTaskDraft.set({ pluginIds })} />
        <ModelPicker value={model} onChange={setModel} allowDefault label="这个任务的模型" />
        <PromptRefine value={draft} onApply={setDraft} optimizationModel={modelReady ? selectedModel : null} />
        <span className="composer-hint">{busy && activeTaskId && runningTitle ? <>「{runningTitle}」正在运行；新任务将排队。<button className="link-button" onClick={() => void openTask(activeTaskId)}>查看</button></> : <><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 开始</>}</span>
        <Button variant="primary" data-testid="start-build" onClick={submit} disabled={!canSubmit} busy={pending === "start"}>{busy ? "创建并排队" : draftConfig.startMode === "plan" ? "开始规划" : "开始任务"}</Button>
      </div>
    </div>
    {!projectReady && <p className="new-task-model-error">请先在左侧选择主工作目录</p>}
    {!capabilityReady && <p className="new-task-model-error">直连项目不能选用沙箱外 Hook/MCP 插件，请移除插件</p>}
    {!modelReady && catalog && <button className="new-task-model-error" onClick={() => openSettings("model")}>当前模型不可用，打开模型设置</button>}
  </div>;
}
