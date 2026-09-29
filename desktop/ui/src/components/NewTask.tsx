import { useEffect, useState, type KeyboardEvent } from "react";
import { ChevronDown, CircleAlert, FolderClosed } from "lucide-react";
import { newTaskDraft } from "../state/new-task-draft";
import { loadDraftFiles, saveDraftFiles } from "../state/draft-files";
import { useStore } from "../state/store";
import { clearStarting, openSettings, startGeneralTask, store } from "../state/workbench";
import { CapabilityPicker, fileLimitReason } from "./CapabilityPicker";
import { ExpertPicker, useEnabledExperts } from "./ExpertPicker";
import { Greeting } from "./Greeting";
import { Halftone } from "./Halftone";
import { ModelPicker } from "./ModelPicker";
import { NewTaskSetup } from "./NewTaskSetup";
import { TaskStarters } from "./TaskStarters";
import { PromptRefine } from "./PromptRefine";
import { Button, Spinner } from "./ui";
import "./NewTask.css";

const GREETING = ["你好，我是 Alpha", "想让我替你完成什么？"];
let savedDraft = localStorage.getItem("alpha-new-task-draft") ?? "";
let savedModel: string | null = null;

export function NewTask() {
  const starting = useStore(store, state => state.starting);
  const pending = useStore(store, state => state.pending);
  // Model runs count against the parallel limit; past it, new tasks wait in the queue.
  const runCount = useStore(store, state => state.runs.length);
  const runLimit = useStore(store, state => state.settings?.budget.maxParallelTasks ?? null);
  const full = runLimit !== null && runCount >= runLimit;
  const catalog = useStore(store, state => state.models);
  const defaultModel = useStore(store, state => state.settings?.model.default ?? null);
  const projects = useStore(store, state => state.projects);
  const draftConfig = useStore(newTaskDraft, state => state);
  const [draft, setDraftState] = useState(() => starting?.brief ?? savedDraft);
  const [model, setModelState] = useState<string | null>(savedModel);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const experts = useEnabledExperts();
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
      files: draftConfig.files, skillIds: draftConfig.skillIds, pluginIds: draftConfig.pluginIds, expertId: draftConfig.expertId,
      model, startMode: draftConfig.startMode, continueUntilAccepted: draftConfig.continueUntilAccepted }).then(() => {
      if (!store.get().starting?.error) {
        setDraft(""); savedModel = null;
        newTaskDraft.set({ files: [], skillIds: [], pluginIds: [], expertId: "" });
      }
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  };

  return <div className="new-task" data-testid="new-task">
    <div className="new-task-hero"><Halftone className="new-task-halftone" /><Greeting lines={GREETING} /></div>
    <button className="new-task-context" aria-expanded={setupOpen || !projectReady} aria-controls="new-task-setup" onClick={() => setSetupOpen(value => !value)} title="更改项目、工作目录和运行方式">
      <FolderClosed size={14} aria-hidden />
      <strong>{selectedProject?.name ?? "临时工作区"}</strong><span>·</span><span className="new-task-context-path" title={selectedMount?.path}>{selectedMount?.path ?? (selectedProject?.mounts.length ? "请选择主工作目录" : "Alpha 管理的工作区")}</span>
      <span>·</span><span>{draftConfig.startMode === "plan" ? "先规划后执行" : "自动批准计划"}{draftConfig.continueUntilAccepted ? " · 持续推进" : ""}</span>
      <ChevronDown size={14} aria-hidden className="new-task-context-chevron" />
    </button>
    {(setupOpen || !projectReady) && <div id="new-task-setup" className="new-task-setup-panel"><NewTaskSetup /></div>}
    {starting?.error && <div className="thread-alert tone-danger" role="alert"><CircleAlert size={16} aria-hidden /><div className="thread-alert-body"><strong>任务没有启动</strong><p>{starting.error}</p></div><div className="thread-alert-actions"><button className="link-button" onClick={clearStarting}>关闭</button></div></div>}
    <div className="composer-box new-task-box">
      <textarea id="brief" data-testid="brief" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown}
        placeholder="描述你要解决的问题、使用的材料和期望结果…" aria-label="描述任务目标" rows={5} />
      <div className="composer-bar">
        <CapabilityPicker files={draftConfig.files} skillIds={draftConfig.skillIds} pluginIds={draftConfig.pluginIds} direct={!!selectedMount}
          onFiles={files => newTaskDraft.set({ files })} onSkills={skillIds => newTaskDraft.set({ skillIds })} onPlugins={pluginIds => newTaskDraft.set({ pluginIds })} />
        <ModelPicker value={model} onChange={setModel} allowDefault label="这个任务的模型" />
        <ExpertPicker value={draftConfig.expertId} onChange={expertId => newTaskDraft.set({ expertId })} placement="down" />
        <PromptRefine value={draft} onApply={setDraft} optimizationModel={modelReady ? selectedModel : null} />
        <span className="composer-hint">{full ? <>已有 {runCount} 个任务在运行，新任务会排队，空出位置后自动开始。<button className="link-button" onClick={() => openSettings("run")}>调整上限</button></> : <><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 开始</>}</span>
        <Button variant="primary" data-testid="start-build" onClick={submit} disabled={!canSubmit} busy={pending === "start"}>{full ? "创建并排队" : draftConfig.startMode === "plan" ? "开始规划" : "开始任务"}</Button>
      </div>
    </div>
    {!projectReady && <p className="new-task-model-error">请先选择主工作目录</p>}
    {!capabilityReady && <p className="new-task-model-error">直连项目不能选用沙箱外 Hook/MCP 插件，请移除插件</p>}
    {!modelReady && catalog && <button className="new-task-model-error" onClick={() => openSettings("model")}>当前模型不可用，打开模型设置</button>}
    {!text && !starting && <TaskStarters experts={experts} onPick={(prompt, expertId) => { setDraft(prompt); newTaskDraft.set({ expertId }); }} />}
  </div>;
}
