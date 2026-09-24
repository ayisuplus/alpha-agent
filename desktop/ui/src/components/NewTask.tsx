import { useEffect, useState, type KeyboardEvent } from "react";
import { CircleAlert, Globe, Hammer, MonitorPlay, PencilLine } from "lucide-react";
import { api } from "../api/client";
import type { Diagnostics, PermissionMode, ProjectRecord } from "../api/types";
import { taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { clearStarting, importTask, openSettings, openTask, startProjectTask, startTask, startWorkflow, store } from "../state/workbench";
import { ModelPicker } from "./ModelPicker";
import { PromptRefine } from "./PromptRefine";
import { Button, Spinner } from "./ui";
import "./NewTask.css";

const EXAMPLES = [
  { title: "个人记账本", text: "构建一个本机个人记账本：可以记录收入和支出、按分类筛选、显示余额，刷新页面后数据仍保存在本机；桌面和 375px 手机宽度都好用。" },
  { title: "带原创插画的阅读日志", text: "制作一个阅读日志页面：可以新增书名和读后感、标记已读；页面顶部需要一幅原创主题插画；刷新后保留记录。" },
  { title: "海边日出冥想页", text: "制作一个本地可用的冥想页：包含一段 5 秒的海边日出原创视频，以及开始 / 暂停冥想计时的按钮，窄屏下也能正常使用。" },
];

const STEPS = [
  { icon: PencilLine, label: "写代码" },
  { icon: Hammer, label: "构建" },
  { icon: MonitorPlay, label: "发布本机预览" },
  { icon: Globe, label: "真实浏览器验收" },
];

let savedDraft = "";
let savedModel: string | null = null;
type NewTaskMode = "web-product" | "code-change" | "project" | "research" | "file-work";
let savedMode: NewTaskMode = "web-product";
let savedImportPath = "";
let savedFiles: File[] = [];
let savedProjectId = "";
let savedMountId = "";
let savedPermissionMode: PermissionMode = "ask";

export function NewTask() {
  const starting = useStore(store, state => state.starting);
  const pending = useStore(store, state => state.pending);
  const activeTaskId = useStore(store, state => state.activeTaskId);
  const busy = useStore(store, state => state.activeRunId !== null || state.operation !== null);
  const catalog = useStore(store, state => state.models);
  const defaultModel = useStore(store, state => state.settings?.model.default ?? null);
  const runningTitle = useStore(store, state => {
    const running = state.tasks.find(item => item.id === state.activeTaskId);
    return running ? taskTitle(running) : null;
  });
  const [draft, setDraftState] = useState(() => starting?.brief ?? savedDraft);
  const [model, setModelState] = useState<string | null>(savedModel);
  const [mode, setModeState] = useState<NewTaskMode>(savedMode);
  const [sourcePath, setSourcePathState] = useState(savedImportPath);
  const [files, setFilesState] = useState<File[]>(savedFiles);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectIdState] = useState(savedProjectId);
  const [mountId, setMountIdState] = useState(savedMountId);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(savedPermissionMode);
  const [newProjectName, setNewProjectName] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [checkingSandbox, setCheckingSandbox] = useState(false);
  const [sandboxReady, setSandboxReady] = useState(false);
  const setProjectId = (value: string) => { savedProjectId = value; savedMountId = ""; setProjectIdState(value); setMountIdState(""); setSandboxReady(false); };
  const setMountId = (value: string) => { savedMountId = value; setMountIdState(value); setSandboxReady(false); };
  const setPermissionMode = (value: PermissionMode) => { savedPermissionMode = value; setPermissionModeState(value); };
  const setDraft = (value: string) => { savedDraft = value; setDraftState(value); };
  const setModel = (value: string | null) => { savedModel = value; setModelState(value); };
  const setMode = (value: NewTaskMode) => { savedMode = value; setModeState(value); };
  const setSourcePath = (value: string) => { savedImportPath = value; setSourcePathState(value); };
  const setFiles = (value: File[]) => { savedFiles = value; setFilesState(value); };
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  useEffect(() => {
    let mounted = true;
    void api.diagnostics().then(result => { if (mounted) setDiagnostics(result); }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  useEffect(() => { void api.projects().then(setProjects).catch(error => setProjectError(error instanceof Error ? error.message : String(error))); }, []);
  const selectedProject = projects.find(item => item.id === projectId);
  const createProject = async () => {
    try { const project = await api.createProject(newProjectName); setProjects(current => [...current, project]); setProjectId(project.id); setNewProjectName(""); setProjectError(null); }
    catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); }
  };
  const addMount = async () => {
    if (!projectId) return;
    try { const project = await api.mountProjectFolder(projectId, mountPath); setProjects(current => current.map(item => item.id === project.id ? project : item)); setMountId(project.mounts.at(-1)?.id ?? ""); setMountPath(""); setProjectError(null); }
    catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); }
  };
  const removeMount = async () => {
    if (!projectId || !mountId) return;
    try { const project = await api.unmountProjectFolder(projectId, mountId); setProjects(current => current.map(item => item.id === project.id ? project : item)); setMountId(""); setProjectError(null); }
    catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); }
  };
  const checkSandbox = async () => {
    if (!projectId || !mountId || checkingSandbox) return;
    setCheckingSandbox(true);
    setSandboxReady(false);
    try { await api.checkProjectSandbox(projectId, mountId); setSandboxReady(true); setProjectError(null); }
    catch (error) { setProjectError(error instanceof Error ? error.message : String(error)); }
    finally { setCheckingSandbox(false); }
  };
  const text = draft.trim();
  const selectedModel = model ?? defaultModel ?? catalog?.builtin;
  const modelReady = !!catalog?.models.some(item => item.selector === selectedModel && item.available);

  if (starting && !starting.error) {
    return <div className="new-task starting" data-testid="new-task">
      <div className="user-message">
        <div className="user-message-meta"><span>目标</span></div>
        <div className="user-message-bubble">{starting.brief}</div>
      </div>
      <p className="new-task-starting"><Spinner size={14} />正在创建任务并启动 Alpha…</p>
    </div>;
  }

  const submit = () => {
    if (!text || busy || pending || !modelReady || (mode === "code-change" && !sourcePath.trim()) || (mode === "project" && (!projectId || !mountId))) return;
    const launch = mode === "project" ? startProjectTask(projectId, mountId, text, permissionMode, model) : mode === "code-change" ? importTask(sourcePath, text, model) : mode === "web-product" ? startTask(text, model) : startWorkflow(mode, text, files, model);
    void launch.then(() => { if (!store.get().starting?.error) { savedDraft = ""; savedModel = null; savedImportPath = ""; setFiles([]); } });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return <div className="new-task" data-testid="new-task">
    <div className="new-task-hero">
      <span className="new-task-mark" aria-hidden>α</span>
      <h1>{mode === "project" ? "在项目中做什么？" : mode === "code-change" ? "要修改哪个项目？" : mode === "research" ? "要研究什么？" : mode === "file-work" ? "要制作什么文件？" : "要构建什么？"}</h1>
      <p>{mode === "project" ? "创建项目并挂载本机文件夹。这个任务会直接修改选中的工作目录，按所选权限档位运行。" : mode === "code-change" ? "导入当前项目快照到受管理工作区，在隔离副本中修改并运行已配置的检查。原目录需单独审阅后才能应用变更。" : mode === "research" ? "描述问题和需要核查的来源。网页来源会记录地址、访问日期和内容指纹，成果附可审阅的来源。" : mode === "file-work" ? "描述 PDF、DOCX 或 XLSX 成果，并可附加输入文件。输入和输出都保留版本与指纹。" : "描述产品、关键交互和验收要求。Alpha 会在本机写代码、构建、发布预览，再用真实浏览器按验收计划逐步检查。"}</p>
    </div>
    <div className="new-task-mode" role="group" aria-label="任务类型">
      <button type="button" aria-pressed={mode === "web-product"} onClick={() => setMode("web-product")}>新建 Web 产品</button>
      <button type="button" aria-pressed={mode === "code-change"} onClick={() => setMode("code-change")}>导入已有项目</button>
      <button type="button" aria-pressed={mode === "project"} onClick={() => setMode("project")}>项目文件夹</button>
      <button type="button" aria-pressed={mode === "research"} onClick={() => setMode("research")}>研究</button>
      <button type="button" aria-pressed={mode === "file-work"} onClick={() => setMode("file-work")}>文件</button>
    </div>
    {mode === "code-change" && <label className="new-task-import-path">项目绝对路径<input value={sourcePath} onChange={event => setSourcePath(event.target.value)} placeholder="E:\\projects\\my-project" aria-label="要导入的项目绝对路径" /></label>}
    {mode === "project" && <div className="new-task-project">
      <label>项目<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>新项目名称<input value={newProjectName} onChange={event => setNewProjectName(event.target.value)} placeholder="项目名称" /></label><button type="button" onClick={() => void createProject()} disabled={!newProjectName.trim()}>创建项目</button>
      {selectedProject && <><label>任务工作目录<select value={mountId} onChange={event => setMountId(event.target.value)}><option value="">选择挂载文件夹</option>{selectedProject.mounts.map(mount => <option key={mount.id} value={mount.id}>{mount.path}</option>)}</select></label>{mountId && <button type="button" onClick={() => void removeMount()}>卸载所选文件夹</button>}
        <label>挂载本机文件夹<input value={mountPath} onChange={event => setMountPath(event.target.value)} placeholder="E:\\projects\\my-project" /></label><button type="button" onClick={() => void addMount()} disabled={!mountPath.trim()}>挂载</button></>}
      <label>这个任务的权限<select value={permissionMode} onChange={event => setPermissionMode(event.target.value as PermissionMode)}><option value="ask">请求批准</option><option value="auto">帮我批准</option><option value="full">完全放开</option></select></label>
      {permissionMode !== "full" && <p>文件和命令在 Windows 低权限沙箱中运行，默认不联网。首次使用可能需要管理员完成本机沙箱配置；配置失败时任务会停下等待处理。</p>}
      {permissionMode !== "full" && <><button type="button" disabled={!projectId || !mountId || checkingSandbox} onClick={() => void checkSandbox()}>{checkingSandbox ? "正在检查沙箱…" : "检查沙箱"}</button>{sandboxReady && <span>本机沙箱拒绝效果已通过</span>}</>}
      {permissionMode === "auto" && <p>独立审查代理只处理可安全批准的命令；高危、越界或不确定操作仍交给你。</p>}
      {permissionMode === "full" && <p>完全放开允许访问整台机器。高危命令会尽力在执行前识别并请求确认；脚本内部行为无法保证拦截。</p>}
      {projectError && <p role="alert">{projectError}</p>}
    </div>}
    {(mode === "research" || mode === "file-work") && <label className="new-task-import-path">输入文件（最多 20 个，总计 50 MB）<input type="file" multiple onChange={event => setFiles(Array.from(event.target.files ?? []))} aria-label="任务输入文件" />{files.length > 0 && <span>{files.map(file => file.name).join("、")}</span>}</label>}
    {starting?.error && <div className="thread-alert tone-danger" role="alert">
      <CircleAlert size={16} aria-hidden />
      <div className="thread-alert-body"><strong>任务没有启动</strong><p>{starting.error}</p></div>
      <div className="thread-alert-actions"><button className="link-button" onClick={clearStarting}>关闭</button></div>
    </div>}
    <div className="new-task-readiness" aria-label="准备情况">
      <strong>准备情况</strong>
      <span className={modelReady ? "ready" : "needs-attention"}>模型：{!catalog ? "正在读取…" : modelReady ? "可用" : "未认证或不可用"}</span>
      {mode === "web-product" && diagnostics && <>
        <span className={diagnostics.checks.find(check => check.id === "comfy")?.ok ? "ready" : "needs-attention"}>ComfyUI：{diagnostics.checks.find(check => check.id === "comfy")?.ok ? "在线" : "未连接，仅影响媒体生成"}</span>
        <span className={diagnostics.checks.find(check => check.id === "browser")?.ok ? "ready" : "needs-attention"}>桌面浏览器：{diagnostics.checks.find(check => check.id === "browser")?.ok ? "可验收" : "不可用，验收需桌面端"}</span>
      </>}
      {!modelReady && catalog && <button className="link-button" onClick={() => openSettings("model")}>去设置模型</button>}
    </div>
    <div className="composer-box new-task-box">
      <textarea
        id="brief"
        data-testid="brief"
        autoFocus
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={mode === "code-change" ? "例如：修复登录后刷新丢失状态的问题，运行现有测试并说明变更…" : mode === "research" ? "例如：研究一个具体问题，列出可核查来源、证据和结论…" : mode === "file-work" ? "例如：根据附加资料制作一份带目录的 DOCX 报告…" : "例如：构建一个本机食谱收藏网页，可以新增食谱名称与分类、切换收藏、按分类筛选，刷新后保留数据…"}
        aria-label={mode === "code-change" ? "描述代码修改任务" : "描述任务目标"}
        rows={5}
      />
      <div className="composer-bar">
        <ModelPicker value={model} onChange={setModel} allowDefault label="这个任务的模型" />
        <PromptRefine value={draft} onApply={setDraft} optimizationModel={modelReady ? selectedModel : null} />
        <span className="composer-hint">
          {busy && activeTaskId && runningTitle
            ? <>「{runningTitle}」正在运行，同一时间只运行一个任务。<button className="link-button" onClick={() => void openTask(activeTaskId)}>查看</button></>
            : <><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 开始</>}
        </span>
        <Button variant="primary" data-testid="start-build" onClick={submit} disabled={!text || busy || !!pending || !modelReady || (mode === "code-change" && !sourcePath.trim()) || (mode === "project" && (!projectId || !mountId))} busy={pending === "start"}>{mode === "code-change" ? "导入并开始" : mode === "web-product" ? "开始构建" : "开始任务"}</Button>
      </div>
    </div>
    {mode === "web-product" && <div className="new-task-examples">
      <span>试试：</span>
      {EXAMPLES.map(example => <button key={example.title} onClick={() => setDraft(example.text)}>{example.title}</button>)}
    </div>}
    <ol className="new-task-steps" aria-label="Alpha 的工作方式">
      {(mode === "code-change" ? [{ icon: PencilLine, label: "修改副本" }, { icon: Hammer, label: "运行检查" }, { icon: MonitorPlay, label: "审阅差异" }, { icon: Globe, label: "应用回原项目" }] : mode === "project" ? [{ icon: PencilLine, label: "直接修改" }, { icon: Hammer, label: "运行检查" }, { icon: MonitorPlay, label: "审阅证据" }] : mode === "web-product" ? STEPS : [{ icon: PencilLine, label: "收集证据" }, { icon: Hammer, label: "制作成果" }, { icon: MonitorPlay, label: "审阅版本" }]).map(({ icon: Icon, label }, index, all) => <li key={label}><Icon size={15} aria-hidden /><span>{label}</span>{index < all.length - 1 && <span className="new-task-arrow" aria-hidden>→</span>}</li>)}
    </ol>
  </div>;
}
