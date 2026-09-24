import { useEffect, useState, type KeyboardEvent } from "react";
import { CircleAlert, Globe, Hammer, MonitorPlay, PencilLine } from "lucide-react";
import { api } from "../api/client";
import type { Diagnostics } from "../api/types";
import { taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { clearStarting, importTask, openSettings, openTask, startTask, startWorkflow, store } from "../state/workbench";
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
type NewTaskMode = "web-product" | "code-change" | "research" | "file-work";
let savedMode: NewTaskMode = "web-product";
let savedImportPath = "";
let savedFiles: File[] = [];

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
    if (!text || busy || pending || !modelReady || (mode === "code-change" && !sourcePath.trim())) return;
    const launch = mode === "code-change" ? importTask(sourcePath, text, model) : mode === "web-product" ? startTask(text, model) : startWorkflow(mode, text, files, model);
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
      <h1>{mode === "code-change" ? "要修改哪个项目？" : mode === "research" ? "要研究什么？" : mode === "file-work" ? "要制作什么文件？" : "要构建什么？"}</h1>
      <p>{mode === "code-change" ? "导入当前项目快照到受管理工作区，在隔离副本中修改并运行已配置的检查。原目录需单独审阅后才能应用变更。" : mode === "research" ? "描述问题和需要核查的来源。网页来源会记录地址、访问日期和内容指纹，成果附可审阅的来源。" : mode === "file-work" ? "描述 PDF、DOCX 或 XLSX 成果，并可附加输入文件。输入和输出都保留版本与指纹。" : "描述产品、关键交互和验收要求。Alpha 会在本机写代码、构建、发布预览，再用真实浏览器按验收计划逐步检查。"}</p>
    </div>
    <div className="new-task-mode" role="group" aria-label="任务类型">
      <button type="button" aria-pressed={mode === "web-product"} onClick={() => setMode("web-product")}>新建 Web 产品</button>
      <button type="button" aria-pressed={mode === "code-change"} onClick={() => setMode("code-change")}>导入已有项目</button>
      <button type="button" aria-pressed={mode === "research"} onClick={() => setMode("research")}>研究</button>
      <button type="button" aria-pressed={mode === "file-work"} onClick={() => setMode("file-work")}>文件</button>
    </div>
    {mode === "code-change" && <label className="new-task-import-path">项目绝对路径<input value={sourcePath} onChange={event => setSourcePath(event.target.value)} placeholder="E:\\projects\\my-project" aria-label="要导入的项目绝对路径" /></label>}
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
        <Button variant="primary" data-testid="start-build" onClick={submit} disabled={!text || busy || !!pending || !modelReady || (mode === "code-change" && !sourcePath.trim())} busy={pending === "start"}>{mode === "code-change" ? "导入并开始" : mode === "web-product" ? "开始构建" : "开始任务"}</Button>
      </div>
    </div>
    {mode === "web-product" && <div className="new-task-examples">
      <span>试试：</span>
      {EXAMPLES.map(example => <button key={example.title} onClick={() => setDraft(example.text)}>{example.title}</button>)}
    </div>}
    <ol className="new-task-steps" aria-label="Alpha 的工作方式">
      {(mode === "code-change" ? [{ icon: PencilLine, label: "修改副本" }, { icon: Hammer, label: "运行检查" }, { icon: MonitorPlay, label: "审阅差异" }, { icon: Globe, label: "应用回原项目" }] : mode === "web-product" ? STEPS : [{ icon: PencilLine, label: "收集证据" }, { icon: Hammer, label: "制作成果" }, { icon: MonitorPlay, label: "审阅版本" }]).map(({ icon: Icon, label }, index, all) => <li key={label}><Icon size={15} aria-hidden /><span>{label}</span>{index < all.length - 1 && <span className="new-task-arrow" aria-hidden>→</span>}</li>)}
    </ol>
  </div>;
}
