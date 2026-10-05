import { tf, t } from "./ui-language";
import { useEffect, useState } from "react";
import type { PlanView } from "../../../../src/native/host-types";
import { sessionRequest } from "./native-api";
import { NativeModal } from "./NativeModal";
import type { SessionController } from "./useSession";
import { desktopStorage } from "./desktop-storage";
import { invokeDesktopCommand } from "./desktop-commands";

export function NativePlan({ session }: { session: SessionController }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [content, setContent] = useState("");
  const [previous, setPrevious] = useState("");
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const id = session.selected!;
  const draftKey = `alpha-plan-review:${id}`;
  const accept = (value: PlanView) => {
    setPlan(value); setContent(value.content); setPrevious(value.content); setFeedback(value.feedback);
    try {
      const saved = JSON.parse(desktopStorage.getItem(draftKey) ?? "null");
      if (value.phase === "review" && saved?.path === value.planFilePath && typeof saved.content === "string" && saved.content !== value.content) {
        setContent(saved.content); setPrevious(saved.previous); setFeedback(saved.feedback ?? value.feedback);
        if (saved.previous !== value.content) session.setError("原计划在编辑期间发生变化。未保存的正文已保留，请复制或重新读取后核对。");
      }
    } catch (cause) { session.setError(String(cause)); }
    setRole(current => value.models.length > 1 ? value.models.some(item => item.role === current) ? current : value.models.find(item => item.role === "default")?.role ?? value.models[0].role : "");
  };
  const load = async () => { desktopStorage.removeItem(draftKey); accept(await sessionRequest<PlanView>(id, "host/mode")); };
  useEffect(() => {
    if (!session.opened) return;
    let current = true;
    void sessionRequest<PlanView>(id, "host/mode").then(value => { if (current) accept(value); }, cause => { if (current) session.setError(String(cause)); });
    return () => { current = false; };
  }, [id, session.opened, session.planRevision]);
  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const value = await sessionRequest<PlanView>(id, "host/plan", { action, content, previous, feedback, role, ...extra });
      if (action !== "cancel-compaction") desktopStorage.removeItem(draftKey);
      accept(value); session.refresh(); void session.reloadList(); return true;
    } catch (cause) { session.setError(String(cause)); return false; }
    finally { setBusy(false); }
  };
  const review = plan?.phase === "review";
  const saveDraft = (body: string, annotations: Record<string, string>) => { try { desktopStorage.setItem(draftKey, JSON.stringify({ path: plan?.planFilePath, content: body, previous, feedback: annotations })); } catch (cause) { session.setError(String(cause)); } };
  const dismiss = async () => { if (!await run("edit")) return; await run("dismiss"); };
  return <div className="native-plan-bar">
    <button disabled={busy || !session.opened} onClick={() => void run("toggle", { content: undefined })}>{plan?.phase === "active" || review ? t("暂停计划") : plan?.phase === "paused" ? t("退出计划") : t("进入计划")}</button>
    {plan?.phase === "paused" && <button disabled={busy} onClick={() => void run("resume")}>{t("继续原计划")}</button>}
    {plan?.content && <button className="native-muted" onClick={() => void invokeDesktopCommand("files", plan.planFilePath)}>{plan.planFilePath}</button>}
    {(plan?.phase === "active" || review) && <button disabled={busy} onClick={() => void run("review")}>{t("审阅计划")}</button>}
    {plan?.error && <span role="alert">{plan.error}</span>}
    {(review || plan?.phase === "compacting") && <NativeModal title={plan.phase === "compacting" ? t("正在压缩计划上下文") : t("审阅计划")} onCancel={() => { if (!busy) void dismiss(); }}>
      {plan.phase === "compacting" ? <><p>{t("完成前不会开始执行。取消后可手动继续任务。")}</p><button onClick={() => void run("cancel-compaction")}>{t("取消压缩")}</button></> : <div className="native-plan-editor">
        <p className="native-muted">{plan.planFilePath} · {plan.contextUsage ? `${plan.contextUsage.tokens} / ${plan.contextUsage.contextWindow} tokens` : t("上下文占用未知")}</p>
        <textarea aria-label={t("计划正文")} rows={14} spellCheck={false} value={content} disabled={busy} onChange={event => { setContent(event.target.value); saveDraft(event.target.value, feedback); }} />
        <div className="native-plan-actions"><button disabled={busy} onClick={() => void run("edit")}>{t("保存修改")}</button><button disabled={busy} onClick={() => void load().catch(cause => session.setError(String(cause)))}>{t("重新读取")}</button>
          {window.alpha?.openEditor && <button disabled={busy} onClick={() => void run("edit").then(ok => ok ? window.alpha?.openEditor?.(plan.physicalPath) : undefined).then(error => { if (typeof error === "string" && error) session.setError(error); })}>{t("外部编辑器")}</button>}
        </div>
        <details><summary>{t("分节反馈")}</summary>{["整体", ...new Set([...content.matchAll(/^#{1,3}\s+(.+)$/gm)].map(match => match[1]))].map(section => <label key={section}>{section}<textarea aria-label={tf`反馈：${section}`} rows={2} value={feedback[section] ?? ""} onChange={event => { const next = { ...feedback, [section]: event.target.value }; setFeedback(next); saveDraft(content, next); }} /></label>)}</details>
        {plan.models.length > 1 && <label>{t("执行模型")}<select aria-label={t("计划执行模型")} value={role} onChange={event => setRole(event.target.value)}>{plan.models.map(model => <option key={model.role} value={model.role}>{model.role} · {model.provider}/{model.id} {model.thinking}</option>)}</select></label>}
        <div className="native-plan-actions">
          <button className="native-primary" disabled={busy} onClick={() => void run("approve-clear")}>{t("批准并清空上下文执行")}</button>
          <button disabled={busy} onClick={() => void run("approve-compact")}>{t("批准并压缩上下文")}</button>
          <button disabled={busy || plan.keepContextDisabled} title={plan.keepContextDisabled ? t("执行上下文超过原生 95% 限制") : undefined} onClick={() => void run("approve-keep")}>{t("批准并保留上下文")}</button>
          <button disabled={busy} onClick={() => void run("refine")}>{t("继续修改")}</button>
          <button disabled={busy || !window.alpha?.saveText} onClick={() => void run("edit").then(async ok => { if (ok && await window.alpha?.saveText?.(`${plan.title}.md`, content)) await run("save-new", { saved: true }); })}>{t("另存并开始新会话")}</button>
          <button disabled={busy} onClick={() => void dismiss()}>{t("关闭审阅")}</button>
        </div>
      </div>}
    </NativeModal>}
  </div>;
}
