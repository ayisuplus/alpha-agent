import { useState, type KeyboardEvent } from "react";
import { CircleAlert, Globe, Hammer, MonitorPlay, PencilLine } from "lucide-react";
import { taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { clearStarting, openTask, startTask, store } from "../state/workbench";
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

export function NewTask() {
  const starting = useStore(store, state => state.starting);
  const pending = useStore(store, state => state.pending);
  const activeTaskId = useStore(store, state => state.activeTaskId);
  const busy = useStore(store, state => state.activeRunId !== null || state.operation !== null);
  const runningTitle = useStore(store, state => {
    const running = state.tasks.find(item => item.id === state.activeTaskId);
    return running ? taskTitle(running) : null;
  });
  const [draft, setDraft] = useState(() => starting?.brief ?? "");
  const text = draft.trim();

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
    if (!text || busy || pending) return;
    void startTask(text);
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
      <h1>要构建什么？</h1>
      <p>描述产品、关键交互和验收要求。Alpha 会在本机写代码、构建、发布预览，再用真实浏览器按验收计划逐步检查。</p>
    </div>
    {starting?.error && <div className="thread-alert tone-danger" role="alert">
      <CircleAlert size={16} aria-hidden />
      <div className="thread-alert-body"><strong>任务没有启动</strong><p>{starting.error}</p></div>
      <div className="thread-alert-actions"><button className="link-button" onClick={clearStarting}>关闭</button></div>
    </div>}
    <div className="composer-box new-task-box">
      <textarea
        id="brief"
        data-testid="brief"
        autoFocus
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="例如：构建一个本机食谱收藏网页，可以新增食谱名称与分类、切换收藏、按分类筛选，刷新后保留数据…"
        aria-label="描述要构建的产品"
        rows={5}
      />
      <div className="composer-bar">
        <span className="composer-hint">
          {busy && activeTaskId && runningTitle
            ? <>「{runningTitle}」正在运行，同一时间只运行一个任务。<button className="link-button" onClick={() => void openTask(activeTaskId)}>查看</button></>
            : <><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 开始</>}
        </span>
        <Button variant="primary" data-testid="start-build" onClick={submit} disabled={!text || busy || !!pending} busy={pending === "start"}>开始构建</Button>
      </div>
    </div>
    <div className="new-task-examples">
      <span>试试：</span>
      {EXAMPLES.map(example => <button key={example.title} onClick={() => setDraft(example.text)}>{example.title}</button>)}
    </div>
    <ol className="new-task-steps" aria-label="Alpha 的工作方式">
      {STEPS.map(({ icon: Icon, label }, index) => <li key={label}><Icon size={15} aria-hidden /><span>{label}</span>{index < STEPS.length - 1 && <span className="new-task-arrow" aria-hidden>→</span>}</li>)}
    </ol>
  </div>;
}
