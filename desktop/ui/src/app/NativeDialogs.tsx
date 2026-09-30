/** 弹窗（方案 8.2：弹窗里的产品名统一为 Alpha）：在其他目录开始、打开网页、扩展交互请求。 */

import type { SessionController } from "./useSession";
import { NativeModal } from "./NativeModal";

function safeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function NativeDialogs({ session, projectDialog, closeProjectDialog, projectPath, setProjectPath }: {
  session: SessionController;
  projectDialog: boolean;
  closeProjectDialog(): void;
  projectPath: string;
  setProjectPath(value: string): void;
}) {
  const create = async () => {
    if (await session.create(projectPath.trim())) { setProjectPath(""); closeProjectDialog(); }
  };
  const openExternal = () => {
    const url = session.externalUrl;
    if (!safeExternalUrl(url)) { session.setError("Alpha 提供的链接协议不受支持。"); return; }
    if (window.alpha?.openExternal) void window.alpha.openExternal(url).then(opened => {
      if (!opened) session.setError("无法打开此链接；请复制链接手动访问。");
    });
    else window.open(url, "_blank");
    session.setExternalUrl("");
  };
  const request = session.uiRequest;
  if (request) return <NativeModal key={request.id} title={request.title ?? "Alpha 需要输入"} onCancel={() => void session.respond(false)}>
    {request.message && <p>{request.message}</p>}
    {request.method === "select"
      ? <select aria-label={request.title ?? "选择选项"} value={session.uiValue} onChange={event => session.setUiValue(event.target.value)}><option value="">请选择</option>{request.options?.map(option => <option key={option}>{option}</option>)}</select>
      : request.method !== "confirm" ? <textarea aria-label={request.title ?? "补充说明"} value={session.uiValue} placeholder={request.placeholder} onChange={event => session.setUiValue(event.target.value)} /> : null}
    <div><button onClick={() => void session.respond(false)}>取消</button><button className="native-primary" disabled={request.method === "select" && !session.uiValue} onClick={() => void session.respond(true)}>确认</button></div>
  </NativeModal>;
  if (session.externalUrl) return <NativeModal title="Alpha 请求打开网页" onCancel={() => session.setExternalUrl("")}>
    <p className="native-muted">{session.externalUrl}</p>
    <div><button onClick={() => session.setExternalUrl("")}>稍后</button><button className="native-primary" onClick={openExternal}>在系统浏览器打开</button></div>
  </NativeModal>;
  return projectDialog ? <NativeModal title="在其他目录开始" onCancel={closeProjectDialog}>
      {window.alpha?.choosePaths && <button onClick={() => void window.alpha!.choosePaths!("directory").then(paths => { if (paths[0]) setProjectPath(paths[0]); }, cause => session.setError(String(cause)))}>选择文件夹</button>}
      <p>输入本机已有的项目目录，Alpha 将直接在其中工作。</p>
      <input className="native-path-input" value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="例如 E:\projects\my-project" />
      <div><button onClick={closeProjectDialog}>取消</button><button className="native-primary" disabled={!projectPath.trim() || session.busy} onClick={() => void create()}>创建会话</button></div>
  </NativeModal> : null;
}
