import { t } from "./ui-language";
/** 打开网页与扩展交互请求。工作目录由首页输入区选择。 */

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

export function NativeDialogs({ session }: {
  session: SessionController;
}) {
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
      ? <select aria-label={request.title ?? "选择选项"} value={session.uiValue} onChange={event => session.setUiValue(event.target.value)}><option value="">{t("请选择")}</option>{request.options?.map(option => <option key={option}>{option}</option>)}</select>
      : request.method !== "confirm" ? <textarea aria-label={request.title ?? "补充说明"} value={session.uiValue} placeholder={request.placeholder} onChange={event => session.setUiValue(event.target.value)} /> : null}
    <div><button onClick={() => void session.respond(false)}>{t("取消")}</button><button className="native-primary" disabled={request.method === "select" && !session.uiValue} onClick={() => void session.respond(true)}>{t("确认")}</button></div>
  </NativeModal>;
  if (session.externalUrl) return <NativeModal title={t("Alpha 请求打开网页")} onCancel={() => session.setExternalUrl("")}>
    <p className="native-muted">{session.externalUrl}</p>
    <div><button onClick={() => session.setExternalUrl("")}>{t("稍后")}</button><button className="native-primary" onClick={openExternal}>{t("在系统浏览器打开")}</button></div>
  </NativeModal>;
  return null;
}
