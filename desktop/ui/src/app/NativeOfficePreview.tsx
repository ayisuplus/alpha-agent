import { useEffect, useRef, useState } from "react";
import type { OfficeViewInfo, OfficeViewRender, OfficeViewSelection } from "../../../../src/native/capabilities/office/office-view";
import { sessionRequest } from "./native-api";
import { OfficePdfPreview } from "./OfficePdfPreview";
import { t } from "./ui-language";

export function NativeOfficePreview({ id, path, staticUrl }: { id: string; path: string; staticUrl: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<OfficeViewInfo | null>(null);
  const [part, setPart] = useState(0), [zoom, setZoom] = useState(1), [revision, setRevision] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0, width: 640, height: 480 });
  const [tile, setTile] = useState<(OfficeViewRender & { x: number; y: number }) | null>(null);
  const [selection, setSelection] = useState<OfficeViewSelection | null>(null);
  const [error, setError] = useState(""), [staticPreview, setStaticPreview] = useState(false);
  const activeView = useRef("");
  activeView.current = `${view?.id}:${part}:${staticPreview}`;
  const call = <T,>(data: unknown) => sessionRequest<T>(id, "office-view", data);

  useEffect(() => {
    let active = true, viewId: string | undefined;
    setView(null); setTile(null); setError(""); setSelection(null);
    if (!staticPreview) void call<OfficeViewInfo>({ path }).then(info => {
      viewId = info.id;
      if (active) { setView(info); setPart(info.part); }
      else void call({ action: "close", viewId }).catch(() => undefined);
    }, error => { if (active) setError(String(error.message ?? error)); });
    return () => { active = false; if (viewId) void call({ action: "close", viewId }).catch(() => undefined); };
  }, [id, path, staticPreview]);

  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const update = () => setPosition({ x: element.scrollLeft, y: element.scrollTop, width: Math.max(1, Math.min(2048, element.clientWidth)), height: Math.max(1, Math.min(2048, element.clientHeight)) });
    const observer = new ResizeObserver(update); observer.observe(element); element.addEventListener("scroll", update); update();
    return () => { observer.disconnect(); element.removeEventListener("scroll", update); };
  }, [view?.id]);

  useEffect(() => {
    if (!view || staticPreview) return;
    let active = true;
    const timer = setTimeout(() => void call<OfficeViewRender>({ action: "render", viewId: view.id, part,
      x: Math.round(position.x * 15 / zoom), y: Math.round(position.y * 15 / zoom), width: position.width, height: position.height, scale: zoom }).then(result => {
      if (!active) return;
      setError("");
      setTile({ ...result, x: position.x, y: position.y });
      setView(current => current?.id === view.id ? { ...current, width: result.documentWidth, height: result.documentHeight } : current);
    }, error => { if (active) setError(String(error.message ?? error)); }), 80);
    return () => { active = false; clearTimeout(timer); };
  }, [view?.id, part, zoom, position, revision, staticPreview]);

  const select = async (event: React.MouseEvent<HTMLDivElement>, count: 1 | 2) => {
    if (!view || !viewport.current) return;
    const key = activeView.current;
    const area = viewport.current, box = area.getBoundingClientRect();
    try {
      const value = await call<OfficeViewSelection>({ action: "select", viewId: view.id, part, count,
        x: Math.round((event.clientX - box.left + area.scrollLeft) * 15 / zoom), y: Math.round((event.clientY - box.top + area.scrollTop) * 15 / zoom) });
      if (activeView.current !== key) return;
      setError(""); setSelection(value); setRevision(value => value + 1);
    } catch (error) { if (activeView.current === key) setError(String(error)); }
  };
  const changePart = (value: number) => { setPart(value); setTile(null); setSelection(null); setError(""); viewport.current?.scrollTo(0, 0); };
  const content = (value: Record<string, unknown>) => String(value.text ?? value.content ?? value.description ?? value.textRange ?? "正文未由当前引擎读出");
  return <section className="native-office-preview" aria-label={t("Office 原格式预览")}>
    <div className="native-office-toolbar"><strong>{staticPreview ? t("静态页面副本") : t("原格式 · 只读")}</strong>
      <button onClick={() => { setStaticPreview(value => !value); setError(""); }}>{staticPreview ? t("原格式预览") : t("静态预览")}</button>
    </div>
    {staticPreview ? <><p className="native-muted">{t("静态副本只显示页面版面；公式、批注及演示交互请在原格式预览或原应用中查看。")}</p><OfficePdfPreview url={staticUrl} label={t("静态文档页面")} /></> : <>
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p className="native-muted">{t("正在打开原文档…")}</p>}
      {view && <>
        <div className="native-office-toolbar">
          {view.kind !== "text" && <label>{view.kind === "spreadsheet" ? t("工作表") : t("幻灯片")} <select value={part} onChange={event => changePart(Number(event.target.value))}>{view.parts.map(item => <option key={item.index} value={item.index}>{item.name || `${item.index + 1}`}{item.hidden ? ` · ${t("隐藏")}` : ""}</option>)}</select></label>}
          <button aria-label={t("缩小文档")} disabled={zoom <= 0.5} onClick={() => setZoom(value => value - 0.25)}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label={t("放大文档")} disabled={zoom >= 3} onClick={() => setZoom(value => value + 0.25)}>+</button>
        </div>
        {view.kind === "presentation" && <p className="native-muted">{t("当前预览幻灯片版面；动画与嵌入媒体请在原应用中播放。")}</p>}
        <div className="native-office-viewport" ref={viewport} onClick={event => { if (view.kind === "spreadsheet") void select(event, 1); }} onDoubleClick={event => void select(event, 2)}>
          <div style={{ width: Math.max(position.width, view.width * zoom / 15), height: Math.max(position.height, view.height * zoom / 15), position: "relative" }}>
            {tile && <img draggable={false} alt={t("原文档视图")} src={`data:${tile.mimeType};base64,${tile.image}`} style={{ position: "absolute", left: tile.x, top: tile.y, width: tile.width, height: tile.height }} />}
          </div>
        </div>
        <p className="native-muted">{view.kind === "spreadsheet" ? t("点击单元格查看内容与公式。") : t("双击文字以选择并复制。")}</p>
        {selection && <div className="native-office-selection">{selection.cellAddress && <strong>{selection.cellAddress}</strong>}{selection.formula && <p>{t("公式")} <code>{selection.formula}</code></p>}{selection.selection && <textarea aria-label={t("所选文字")} readOnly value={selection.selection} />}</div>}
        {(view.comments.length > 0 || view.revisions.length > 0) && <details className="native-office-notes"><summary>{t("批注与修订")} · {view.comments.length + view.revisions.length}</summary>{[...view.comments, ...view.revisions].map((item, index) => <p key={index}><strong>{String(item.author ?? "")}</strong> {content(item)}</p>)}</details>}
        {view.notes?.some(note => note.part === part && note.text) && <details className="native-office-notes"><summary>{t("演讲者备注")}</summary>{view.notes.filter(note => note.part === part).map((note, index) => <p key={index}>{note.text}</p>)}</details>}
      </>}
    </>}
  </section>;
}
