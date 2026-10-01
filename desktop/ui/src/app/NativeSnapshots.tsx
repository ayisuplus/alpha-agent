import { t } from "./ui-language";
import { useEffect, useState } from "react";
import { sessionRequest } from "./native-api";
import { NativeModal } from "./NativeModal";
import type { SessionController } from "./useSession";
type Turn = { id: string; sessionId: string; startedAt: string; finishedAt?: string; settled: boolean; outcome?: string; changed: string[] };
type Restoration = { id: string; turnId: string; undone: boolean; status?: string; error?: string };
export function NativeSnapshots({ session }: { session: SessionController }) {
  const [items, setItems] = useState<{ turns: Turn[]; restorations: Restoration[] }>({ turns: [], restorations: [] });
  const [selection, setSelection] = useState<{ id: string; redo: boolean; diff: string; conflicts: string[] } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = async () => setItems(await sessionRequest(session.selected!, "snapshots"));
  useEffect(() => { let active = true; const refresh = () => { if (active) void load().catch(cause => setError(String(cause))); }; refresh(); const timer = setInterval(refresh, 2000); return () => { active = false; clearInterval(timer); }; }, [session.selected, session.messages.length, session.busy]);
  const preview = async (id: string, redo = false) => { setBusy(true); setError(""); try { const value = await sessionRequest<{ diff: string; conflicts: string[] }>(session.selected!, "snapshots", { action: "preview", id, redo }); setSelection({ id, redo, ...value }); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  const restore = async () => {
    if (!selection) return; setBusy(true); setError("");
    try { const result = await sessionRequest<{ restored: boolean; conflicts: string[] }>(session.selected!, "snapshots", { action: "restore", id: selection.id, redo: selection.redo }); if (!result.restored) setSelection({ ...selection, conflicts: result.conflicts }); else { setSelection(null); await load(); session.refresh(); } } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  return <section><h4>{t("文件恢复")} <button disabled={busy} onClick={() => void load().catch(cause => setError(String(cause)))}>{t("刷新记录")}</button></h4>
    <p className="native-muted">{t("任务开始和真正结束时保存独立快照。原有暂存区保留；后续文件变动会阻止恢复。")}</p>
    {items.turns.slice().reverse().map(turn => <div className="native-snapshot" key={turn.id}><time>{new Date(turn.startedAt).toLocaleString()}</time><small>{turn.changed.length} {t("个文件 ·")} {turn.outcome ?? "工作中"}{turn.sessionId !== session.selected ? t(" · 其他会话") : ""}</small><button disabled={busy || session.busy || !turn.settled || !turn.changed.length} onClick={() => void preview(turn.id)}>{t("预览撤销")}</button></div>)}
    {!items.turns.length && <p className="native-muted">{t("下一次任务开始时保存快照。")}</p>}
    {items.restorations.filter(item => !item.undone).map(item => <div className="native-snapshot" key={item.id}><span>{item.status === "applying" ? t("恢复中断 · 备份可用") : t("已撤销文件改动")}</span><button disabled={busy || session.busy} onClick={() => void preview(item.id, true)}>{t("预览重做")}</button></div>)}
    {items.restorations.filter(item => item.error).map(item => <p key={item.id} role="alert">{item.error}</p>)}
    {error && <p role="alert">{t(error)}</p>}
    {selection && <NativeModal title={selection.redo ? t("重做文件改动") : t("撤销文件改动")} onCancel={() => { if (!busy) setSelection(null); }}>
      <p>{t("确认后按以下差异恢复文件。不会重置仓库或改动暂存区。")}</p>
      {selection.conflicts.length > 0 && <p role="alert">{t("以下内容在快照后发生变化，恢复已停止：")}{selection.conflicts.join("、")}</p>}
      <pre className="native-review-output">{selection.diff || "没有文件差异"}</pre>
      {error && <p role="alert">{t(error)}</p>}<div className="native-dialog-actions"><button disabled={busy} onClick={() => setSelection(null)}>{t("取消")}</button><button disabled={busy || selection.conflicts.length > 0} onClick={() => void restore()}>{t("确认")}{selection.redo ? t("重做") : t("撤销")}</button></div>
    </NativeModal>}
  </section>;
}
