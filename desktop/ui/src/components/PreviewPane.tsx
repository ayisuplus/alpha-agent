import { useEffect, useRef, useState } from "react";
import { Copy, Hand, MonitorOff, MonitorPlay, PanelRightClose, PanelRightOpen, RotateCw, Undo2 } from "lucide-react";
import { taskTitle } from "../state/labels";
import { useStore } from "../state/store";
import { browserOwner, isOccupied, notify, republish, store, toggleControl, verifyTask } from "../state/workbench";
import { Button, IconButton, Spinner, StatusDot } from "./ui";
import "./PreviewPane.css";

type Shown = { taskId: string; url: string } | null;

/**
 * Which page the single visible preview should hold. While a task works in the browser, the view stays reserved for
 * it and selecting another task never switches it ("keep"), so browser verification is never interrupted. Tasks that
 * run without the browser leave the view to the selected task.
 */
function usePreviewTarget(): Shown | "keep" {
  const owner = useStore(store, browserOwner);
  const selectedId = useStore(store, state => state.selectedId);
  const task = useStore(store, state => state.task);
  const running = useStore(store, state => state.runningPreview);
  if (owner) {
    const fromRun = running?.taskId === owner ? running : null;
    if (task?.id === owner) return task.preview?.live ? { taskId: task.id, url: task.preview.url } : fromRun;
    return fromRun ?? "keep";
  }
  if (!task) return selectedId === null ? null : "keep";
  return task.preview?.live ? { taskId: task.id, url: task.preview.url } : null;
}

export function PreviewPane({ layoutKey, collapsed, locked, onToggle, showClose = true }: { layoutKey: string; collapsed: boolean; locked: boolean; onToggle(): void; showClose?: boolean }) {
  const target = usePreviewTarget();
  const [shown, setShown] = useState<Shown>(null);
  const slot = useRef<HTMLDivElement>(null);

  const task = useStore(store, state => state.task);
  const selectedId = useStore(store, state => state.selectedId);
  const browserTask = useStore(store, browserOwner);
  const controlHolder = useStore(store, state => state.controlHolder);
  const pending = useStore(store, state => state.pending);
  const occupied = useStore(store, state => isOccupied(state, state.selectedId));
  const tasks = useStore(store, state => state.tasks);
  const titleOf = (id: string | null | undefined) => {
    const item = tasks.find(candidate => candidate.id === id);
    return item ? taskTitle(item) : null;
  };

  const targetKey = target === "keep" ? "keep" : target ? `${target.taskId} ${target.url}` : "none";
  useEffect(() => {
    if (target === "keep") return;
    if ((target?.url ?? null) === (shown?.url ?? null) && (target?.taskId ?? null) === (shown?.taskId ?? null)) return;
    setShown(target);
  }, [targetKey]); // Keyed by the target's identity rather than its object reference.

  const visible = !!shown && !collapsed;

  const owner = shown && shown.taskId !== selectedId ? titleOf(shown.taskId) : null;
  const userControls = controlHolder === "user";
  const canVerify = !!task && task.status === "active" && !!task.preview?.live && task.pending.includes("user-path")
    && !userControls && !occupied && shown?.taskId === task.id;
  const canRepublish = !!task && !task.preview?.live && !task.running && task.status !== "stopped" && !occupied;

  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.url);
      notify("已复制预览地址", "info");
    } catch { notify("无法访问剪贴板"); }
  };

  let label: string;
  if (shown && userControls) label = "你正在操作预览，Alpha 已暂停验收";
  else if (shown && owner) label = `正在显示「${owner}」的预览`;
  else if (shown) label = "在线";
  else if (task?.preview && !task.preview.live) label = "预览已停止";
  else label = "没有在线预览";

  let emptyTitle = "选择或新建任务后，产品预览会显示在这里";
  let emptyDetail: string | null = null;
  if (browserTask && browserTask !== selectedId) {
    emptyTitle = "预览窗口正由另一个任务使用";
    emptyDetail = `「${titleOf(browserTask) ?? "另一个任务"}」正在浏览器里验收，结束后切回当前任务。`;
  } else if (task?.running) {
    emptyTitle = "构建完成后，预览会在这里打开";
    emptyDetail = "Alpha 会先构建产品，再发布本机预览并用这个浏览器逐步验收。";
  } else if (task?.preview && !task.preview.live) {
    emptyTitle = "预览服务已停止";
    emptyDetail = "Alpha 重启后，旧预览不会自动恢复。重新发布后会再做一次浏览器验收。";
  } else if (task) {
    emptyTitle = "这个任务还没有可用的预览";
    emptyDetail = task.status === "stopped" ? "任务已停止。继续修复后会重新构建和发布。" : null;
  } else if (selectedId) emptyTitle = "正在加载…";

  const tone = shown ? (userControls ? "warning" : "success") : "neutral";
  if (collapsed) {
    return <aside className="preview-rail" aria-label="产品预览（已收起）">
      <IconButton icon={PanelRightOpen} label="展开预览栏 (Ctrl+Shift+B)" onClick={onToggle} />
      <span className="preview-rail-state" title={label}><StatusDot tone={tone} /></span>
    </aside>;
  }

  return <section className="preview-pane" aria-label="产品预览">
    <header className={["preview-toolbar", userControls && shown ? "controlled" : ""].filter(Boolean).join(" ")}>
      <StatusDot tone={tone} />
      <span className="preview-label">{label}</span>
      {shown && <code className="preview-url" title={shown.url}>{shown.url.replace(/^http:\/\//, "")}</code>}
      {shown && <IconButton icon={Copy} label="复制预览地址" size={14} onClick={() => void copy()} />}
      <span className="preview-actions">
        {canVerify && <Button size="sm" icon={RotateCw} onClick={() => void verifyTask()} busy={pending === "verify"}>重新验收</Button>}
        {shown && (userControls
          ? <Button size="sm" variant="primary" icon={Undo2} onClick={() => void toggleControl()} busy={pending === "control"}>交回 Alpha</Button>
          : <Button size="sm" icon={Hand} onClick={() => void toggleControl()} busy={pending === "control"} title="暂停 Alpha 的浏览器操作，由你直接操作预览">接管操作</Button>)}
        {showClose && <IconButton icon={PanelRightClose} label={locked ? "浏览器正在使用预览，暂时不能收起" : "收起预览栏 (Ctrl+Shift+B)"} onClick={onToggle} disabled={locked} />}
      </span>
    </header>
    <div className="preview-slot" ref={slot} data-testid="preview-slot">
      {!shown && <div className="preview-empty">
          {task?.running && !owner ? <Spinner size={22} /> : task?.preview && !task.preview.live ? <MonitorOff size={26} aria-hidden /> : <MonitorPlay size={26} aria-hidden />}
          <strong>{emptyTitle}</strong>
          {emptyDetail && <p>{emptyDetail}</p>}
          {canRepublish && <Button variant="primary" icon={RotateCw} onClick={() => void republish()} busy={pending === "publish"}>重新发布并验收</Button>}
        </div>}
    </div>
  </section>;
}
