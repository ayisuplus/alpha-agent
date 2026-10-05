import { useEffect, useState } from "react";
import { Field } from "../components/settings/controls";
import { nativeApi } from "./native-api";
import { t } from "./ui-language";
type Status = { current: string; installed: boolean; source: string | null; phase: string; error: string | null; latest?: string; available?: boolean; transactions: Array<{ id: string; state: string; version: string; updatedAt?: string; error?: string; backup?: string }> };
export function NativeAppUpdates() {
  const [status, setStatus] = useState<Status | null>(null), [source, setSource] = useState(""), [path, setPath] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const read = async () => { const value = await nativeApi<Status>("app-updates"); setStatus(current => ({ ...current, ...value })); return value; };
  useEffect(() => { void read().then(value => setSource(value.source ?? ""), cause => setError(String(cause))); const timer = setInterval(() => void read().catch(cause => setError(String(cause))), 3000); return () => clearInterval(timer); }, []);
  const run = async (input: Record<string, unknown>) => { setBusy(true); setError(""); try { setStatus(await nativeApi<Status>("app-updates", input)); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  const prepared = status?.transactions.find(row => row.state === "prepared");
  const recovery = status?.transactions.find(row => ["applying", "launching", "recovery-needed"].includes(row.state));
  return <details className="native-app-updates"><summary>{t("Alpha 应用更新")}</summary>
    <p>{t("当前版本")} · {status?.current}</p>
    {!status?.installed && <p>{t("当前为开发目录。安装与重启更新在 Alpha 发行包中可用。")}</p>}
    <Field label={t("更新源")} description={t("填写本机更新清单路径或 HTTPS 清单地址。清单包含 version、url、sha256；未配置时不会检测 Alpha 新版本。")}><input aria-label={t("Alpha 更新源")} value={source} onChange={event => setSource(event.target.value)} /><button disabled={busy} onClick={() => void run({ action: "source", source })}>{t("保存")}</button><button disabled={busy || !status?.source} onClick={() => void run({ action: "check" })}>{t("检测应用更新")}</button></Field>
    {!status?.source && <p>{t("尚未配置应用更新源。")}</p>}{status?.latest && <p>{t("更新源版本")} · {status.latest} · {status.available ? t("有新版本") : t("当前版本已是最新")}</p>}
    <Field label={t("本地更新包")} description={t("使用完整 Alpha 便携发行目录或 ZIP。准备阶段校验整个包，安装时保留本机数据和用户文件。")}><input aria-label={t("本地更新包路径")} value={path} onChange={event => setPath(event.target.value)} />
      {window.alpha?.choosePaths && <><button disabled={busy} onClick={() => void window.alpha!.choosePaths!("directory").then(paths => { if (paths[0]) setPath(paths[0]); }, cause => setError(String(cause)))}>{t("选择发行目录")}</button><button disabled={busy} onClick={() => void window.alpha!.choosePaths!("files").then(paths => { if (paths[0]) setPath(paths[0]); }, cause => setError(String(cause)))}>{t("选择 ZIP")}</button></>}
    </Field>
    <button disabled={busy || !status?.installed || !path && !status.source} onClick={() => void run({ action: "prepare", ...(path ? { path } : {}) })}>{t("下载并校验 / 准备本地包")}</button>
    {(busy || status?.phase === "preparing") && <button onClick={() => void nativeApi("app-updates", { action: "cancel" }).catch(cause => setError(String(cause)))}>{t("取消准备")}</button>}
    <p role="status">{t(status?.phase ?? "idle")}</p>
    {recovery && <><p>{t("检测到中断的更新，可退出并恢复上一版本。")}</p><button disabled={busy || !window.alpha?.installUpdate} onClick={() => { setBusy(true); void window.alpha!.installUpdate!(recovery.id).catch(cause => { setError(String(cause)); setBusy(false); }); }}>{t("恢复上一版本并重启")}</button></>}
    {prepared && <><p>{t("已准备版本")} · {prepared.version}</p><p>{t("安装将关闭桌面和项目终端，保留备份并重新启动。新版本启动失败时恢复旧版本；运行中的任务会阻止安装。")}</p><button disabled={busy || !window.alpha?.installUpdate} onClick={() => { setBusy(true); setError(""); void window.alpha!.installUpdate!(prepared.id).catch(cause => { setError(String(cause)); setBusy(false); }); }}>{t("安装并重启")}</button></>}
    {(error || status?.error) && <p role="alert" className="native-settings-error">{error || status?.error}</p>}
    <details><summary>{t("更新记录与备份")}</summary>{status?.transactions.map(row => <div key={row.id}><p>{row.version} · {t(row.state)} · {row.updatedAt}</p>{row.error && <p role="alert">{row.error}</p>}{row.backup && <p>{row.backup}</p>}</div>)}</details>
  </details>;
}
