import { tf, t } from "./ui-language";
import { useEffect, useState } from "react";
import { ArrowLeft, Download, FileText, FolderOpen, RotateCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { serverToken, sessionRequest } from "./native-api";
import type { SessionController } from "./useSession";
import { OfficePdfPreview } from "./OfficePdfPreview";
import { desktopStorage } from "./desktop-storage";

type Directory = { path: string; relative: string; files: Array<{ name: string; path: string; type: string; size?: number }> };
type Preview = { path: string; name: string; size: number; kind: string; text?: string; truncated?: boolean; reason?: string };

function FilePreview({ id, path, onBack, session, initialLine = 1 }: { id: string; path: string; onBack(): void; session: SessionController; initialLine?: number }) {
  const [file, setFile] = useState<Preview | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [range, setRange] = useState({ start: initialLine, end: initialLine });
  const [source, setSource] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFile(null); setUrl(""); setError("");
    void Promise.all([sessionRequest<Preview>(id, `file?path=${encodeURIComponent(path)}`), serverToken()]).then(([value, token]) => {
      if (cancelled) return;
      setFile(value);
      setUrl(`/api/native/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}&raw=1&token=${encodeURIComponent(token)}&v=${refresh}`);
    }, cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [id, path, refresh]);
  const open = async () => {
    const cause = await window.alpha?.openFolder?.(file?.path ?? path);
    if (cause) setError(cause);
  };
  const lines = file?.text?.split(/\r?\n/) ?? [];
  const quote = () => {
    const start = Math.max(1, Math.min(lines.length, Math.floor(range.start))), end = Math.max(start, Math.min(lines.length, Math.floor(range.end)));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start > 1000) { setError("一次最多引用 1000 行"); return; }
    session.prefill(`@${JSON.stringify(`${path}:${start}-${end}`)}\n\n${lines.slice(start - 1, end).join("\n")}\n`);
  };
  return <div className="native-file-preview">
    <div className="native-file-actions">
      <button onClick={onBack}><ArrowLeft size={14} /> {t("文件列表")}</button>
      <button onClick={() => setRefresh(value => value + 1)} aria-label={t("刷新文件预览")} title={t("刷新文件预览")}><RotateCw size={14} /></button>
      {url && <a href={`${url}&download=1`} download={file?.name} title={t("下载原文件")} aria-label={t("下载原文件")}><Download size={14} /></a>}
      {window.alpha?.openFolder && <button onClick={() => void open()}>{t("系统打开")}</button>}
      {file && window.alpha?.openEditor && <button onClick={() => void window.alpha?.openEditor?.(file.path).then(cause => { if (cause) setError(cause); })}>{t("外部编辑器")}</button>}
    </div>
    <h3 title={path}>{file?.name ?? path.split(/[\\/]/).at(-1)}</h3>
    {error ? <p role="alert">{t(error)}</p> : !file ? <p className="native-muted">{t("正在读取文件…")}</p> : <>
      <p className="native-muted">{Math.ceil(file.size / 1024)} {t("KB · 只读预览")}</p>
      {file.truncated && <p className="native-muted">{t("文件较大，仅显示前 1 MB；可下载查看完整内容。")}</p>}
      {file.kind === "unsupported" && <p className="native-muted">{file.reason}</p>}
      {lines.length > 0 && <div className="native-line-reference"><label>{t("起始行")}<input type="number" min={1} max={lines.length} value={range.start} onChange={event => setRange({ ...range, start: Number(event.target.value) })} /></label><label>{t("结束行")}<input type="number" min={range.start} max={lines.length} value={range.end} onChange={event => setRange({ ...range, end: Number(event.target.value) })} /></label><button onClick={quote}>{t("引用行范围")}</button>{file.kind !== "text" && <button onClick={() => setSource(value => !value)}>{source ? t("阅读预览") : t("查看源码")}</button>}</div>}
      {(file.kind === "text" || source) && <div className="native-file-text native-numbered-lines">{lines.slice(0, 3000).map((line, number) => <div key={number} className={number + 1 >= range.start && number + 1 <= range.end ? "selected" : ""}><button onClick={event => setRange(event.shiftKey ? { start: Math.min(range.start, number + 1), end: Math.max(range.start, number + 1) } : { start: number + 1, end: number + 1 })} title={t("点击选择；Shift 点击选择范围")}>{number + 1}</button><code>{line || " "}</code></div>)}{lines.length > 3000 && <p className="native-muted">{t("显示前 3000 行，可用行范围引用或下载完整文件。")}</p>}</div>}
      {file.kind === "markdown" && !source && <div className="native-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{t("[图片：")}{alt || "附件"}]</span>, a: ({ children }) => <span>{children}</span> }}>{file.text ?? ""}</ReactMarkdown></div>}
      {file.kind === "html" && !source && <iframe title={t("HTML 文件预览")} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${file.text ?? ""}`} />}
      {file.kind === "image" && <img className="native-file-image" src={url} alt={file.name} onError={() => setError("图片无法预览，请下载或在系统应用中打开。")} />}
      {file.kind === "video" && <video src={url} controls preload="metadata" onError={() => setError("此视频格式无法在浏览器播放，请下载或在系统应用中打开。")} />}
      {file.kind === "audio" && <audio src={url} controls preload="metadata" onError={() => setError("此音频格式无法在浏览器播放，请下载或在系统应用中打开。")} />}
      {(file.kind === "pdf" || file.kind === "office") && <OfficePdfPreview key={`${path}:${refresh}`} url={`${url}&preview=1`} label={t("文档页面")} />}
    </>}
  </div>;
}

export function NativeFiles({ session, visible, previewPath, onPreviewPath }: { session: SessionController; visible: boolean; previewPath: string | null; onPreviewPath(path: string | null): void }) {
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState("");
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tabs, setTabs] = useState<string[]>(() => { try { return JSON.parse(desktopStorage.getItem(`alpha-file-tabs:${session.selected}`) ?? "[]"); } catch { return []; } });
  const [query, setQuery] = useState(""), [contentSearch, setContentSearch] = useState(false), [matches, setMatches] = useState<Array<{ path: string; lineNumber?: number; line?: string; isDirectory?: boolean }>>([]), [limitReached, setLimitReached] = useState(false), [line, setLine] = useState(1);
  const choose = (path: string, line = 1) => { setSelected(path); setLine(line); setTabs(current => current.includes(path) ? current : [...current, path]); };
  useEffect(() => { if (previewPath) choose(previewPath); }, [previewPath]);
  useEffect(() => { desktopStorage.setItem(`alpha-file-tabs:${session.selected}`, JSON.stringify(tabs)); }, [tabs, session.selected]);
  useEffect(() => {
    if (!visible || !query.trim() || !session.selected) { setMatches([]); return; }
    let cancelled = false; const timer = setTimeout(() => void sessionRequest<{ matches: typeof matches; limitReached?: boolean }>(session.selected!, `search?q=${encodeURIComponent(query)}&content=${contentSearch ? 1 : 0}`).then(value => { if (!cancelled) { setMatches(value.matches); setLimitReached(!!value.limitReached); } }, cause => { if (!cancelled) setError(String(cause)); }), 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, session.selected, query, contentSearch]);
  useEffect(() => {
    if (!visible || !session.selected) return;
    let cancelled = false;
    setDirectory(null); setError("");
    void sessionRequest<Directory>(session.selected, `files?path=${encodeURIComponent(path || ".")}`).then(result => { if (!cancelled) setDirectory(result); }, cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [session.selected, path, session.files, refresh, visible]);
  if (!visible) return null;
  if (!session.selected) return <div className="native-panel"><p className="native-muted">{t("选择会话后，可以浏览和预览项目文件。")}</p></div>;
  return <div className="native-panel">
    <nav className="native-file-tabs" aria-label={t("文件标签")}>{tabs.map(path => <span key={path}><button aria-pressed={selected === path} title={path} onClick={() => choose(path)}>{path.split(/[\\/]/).at(-1)}</button><button aria-label={tf`关闭 ${path}`} onClick={() => { setTabs(current => current.filter(item => item !== path)); if (selected === path) { setSelected(""); onPreviewPath(null); } }}>×</button></span>)}</nav>
    {selected ? <FilePreview key={`${selected}:${line}`} session={session} id={session.selected} path={selected} initialLine={line} onBack={() => { setSelected(""); onPreviewPath(null); }} /> : <>
      <h3>{t("项目文件")}</h3><p className="native-muted">{directory?.path ?? session.current?.cwd}</p>
      <div className="native-file-actions">
        <button onClick={() => setPath("")}>{t("项目根目录")}</button>
        <button disabled={!directory?.relative} onClick={() => setPath(`${directory!.relative}/..`)}>{t("上一级")}</button>
        <button onClick={() => setRefresh(value => value + 1)} aria-label={t("刷新文件列表")} title={t("刷新文件列表")}><RotateCw size={14} /></button>
      </div>
      <div className="native-file-search"><input aria-label={t("搜索项目文件")} placeholder={contentSearch ? t("搜索文件内容…") : t("搜索文件路径…")} value={query} onChange={event => { setQuery(event.target.value); setError(""); }} /><label><input type="checkbox" checked={contentSearch} onChange={event => setContentSearch(event.target.checked)} /> {t("内容")}</label></div>
      {limitReached && query && <p className="native-muted">{t("结果较多，请缩小搜索范围。")}</p>}
      {error ? <p role="alert">{t(error)}</p> : query.trim() ? matches.length ? matches.map((match, index) => <div className="native-file" key={`${match.path}:${index}`}><button title={match.path} onClick={() => match.isDirectory ? (setPath(match.path), setQuery("")) : choose(match.path, match.lineNumber)}>{match.path.split(/[\\/]/).at(-1)}{match.lineNumber ? `:${match.lineNumber}` : ""}</button><small>{match.line}</small></div>) : <p className="native-muted">{t("没有匹配文件。")}</p> : !directory ? <p className="native-muted">{t("正在读取目录…")}</p> : !directory.files.length ? <p className="native-muted">{t("此目录为空。")}</p> : directory.files.map(file => <div className="native-file" key={file.path}>
        {file.type === "directory" ? <FolderOpen size={14} /> : <FileText size={14} />}
        <button title={file.name} onClick={() => file.type === "directory" ? setPath(file.path) : choose(file.path)}>{file.name}</button>
        <small>{file.type === "directory" ? t("目录") : `${Math.ceil((file.size ?? 0) / 1024)} KB`}</small>
      </div>)}
    </>}
  </div>;
}
