import { useEffect, useState } from "react";
import { ArrowLeft, Download, FileText, FolderOpen, RotateCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { serverToken, sessionRequest } from "./native-api";
import type { SessionController } from "./useSession";
import { OfficePdfPreview } from "./OfficePdfPreview";

type Directory = { path: string; relative: string; files: Array<{ name: string; path: string; type: string; size?: number }> };
type Preview = { path: string; name: string; size: number; kind: string; text?: string; truncated?: boolean; reason?: string };

function FilePreview({ id, path, onBack }: { id: string; path: string; onBack(): void }) {
  const [file, setFile] = useState<Preview | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
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
  return <div className="native-file-preview">
    <div className="native-file-actions">
      <button onClick={onBack}><ArrowLeft size={14} /> 文件列表</button>
      <button onClick={() => setRefresh(value => value + 1)} aria-label="刷新文件预览" title="刷新文件预览"><RotateCw size={14} /></button>
      {url && <a href={`${url}&download=1`} download={file?.name} title="下载原文件" aria-label="下载原文件"><Download size={14} /></a>}
      {window.alpha?.openFolder && <button onClick={() => void open()}>系统打开</button>}
    </div>
    <h3 title={path}>{file?.name ?? path.split(/[\\/]/).at(-1)}</h3>
    {error ? <p role="alert">{error}</p> : !file ? <p className="native-muted">正在读取文件…</p> : <>
      <p className="native-muted">{Math.ceil(file.size / 1024)} KB · 只读预览</p>
      {file.truncated && <p className="native-muted">文件较大，仅显示前 1 MB；可下载查看完整内容。</p>}
      {file.kind === "unsupported" && <p className="native-muted">{file.reason}</p>}
      {file.kind === "text" && <pre className="native-file-text">{file.text}</pre>}
      {file.kind === "markdown" && <div className="native-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[图片：{alt || "附件"}]</span>, a: ({ children }) => <span>{children}</span> }}>{file.text ?? ""}</ReactMarkdown></div>}
      {file.kind === "html" && <iframe title="HTML 文件预览" sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${file.text ?? ""}`} />}
      {file.kind === "image" && <img className="native-file-image" src={url} alt={file.name} onError={() => setError("图片无法预览，请下载或在系统应用中打开。")} />}
      {file.kind === "video" && <video src={url} controls preload="metadata" onError={() => setError("此视频格式无法在浏览器播放，请下载或在系统应用中打开。")} />}
      {file.kind === "audio" && <audio src={url} controls preload="metadata" onError={() => setError("此音频格式无法在浏览器播放，请下载或在系统应用中打开。")} />}
      {(file.kind === "pdf" || file.kind === "office") && <OfficePdfPreview key={`${path}:${refresh}`} url={`${url}&preview=1`} label="文档页面" />}
    </>}
  </div>;
}

export function NativeFiles({ session, visible, previewPath, onPreviewPath }: { session: SessionController; visible: boolean; previewPath: string | null; onPreviewPath(path: string | null): void }) {
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState("");
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { if (previewPath) setSelected(previewPath); }, [previewPath]);
  useEffect(() => {
    if (!visible || !session.selected) return;
    let cancelled = false;
    setDirectory(null); setError("");
    void sessionRequest<Directory>(session.selected, `files?path=${encodeURIComponent(path || ".")}`).then(result => { if (!cancelled) setDirectory(result); }, cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [session.selected, path, session.files, refresh, visible]);
  if (!visible) return null;
  if (!session.selected) return <div className="native-panel"><p className="native-muted">选择会话后，可以浏览和预览项目文件。</p></div>;
  return <div className="native-panel">
    {selected ? <FilePreview key={selected} id={session.selected} path={selected} onBack={() => { setSelected(""); onPreviewPath(null); }} /> : <>
      <h3>项目文件</h3><p className="native-muted">{directory?.path ?? session.current?.cwd}</p>
      <div className="native-file-actions">
        <button onClick={() => setPath("")}>项目根目录</button>
        <button disabled={!directory?.relative} onClick={() => setPath(`${directory!.relative}/..`)}>上一级</button>
        <button onClick={() => setRefresh(value => value + 1)} aria-label="刷新文件列表" title="刷新文件列表"><RotateCw size={14} /></button>
      </div>
      {error ? <p role="alert">{error}</p> : !directory ? <p className="native-muted">正在读取目录…</p> : !directory.files.length ? <p className="native-muted">此目录为空。</p> : directory.files.map(file => <div className="native-file" key={file.path}>
        {file.type === "directory" ? <FolderOpen size={14} /> : <FileText size={14} />}
        <button title={file.name} onClick={() => file.type === "directory" ? setPath(file.path) : setSelected(file.path)}>{file.name}</button>
        <small>{file.type === "directory" ? "目录" : `${Math.ceil((file.size ?? 0) / 1024)} KB`}</small>
      </div>)}
    </>}
  </div>;
}
