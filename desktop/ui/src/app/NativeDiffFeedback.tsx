import { useState } from "react";
import { NativeModal } from "./NativeModal";
import type { SessionController } from "./useSession";
import { desktopStorage } from "./desktop-storage";
export function diffRows(lines: string[]) {
  let before = 0, after = 0;
  return lines.map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); return { text }; }
    if (!before && !after || /^(diff |index |--- |\+\+\+ |\\ No newline)/.test(text)) return { text };
    return text.startsWith("+") ? { text, after: after++ } : text.startsWith("-") ? { text, before: before++ } : { text, before: before++, after: after++ };
  });
}
type Feedback = { path: string; line: number; side: "原文件" | "当前文件"; excerpt: string; text: string };
export function NativeDiffFeedback({ session, path, lines, source }: { session: SessionController; path: string; lines: string[]; source: string }) {
  const key = `alpha-review-feedback:${session.selected}:${source}`;
  const [feedback, setFeedback] = useState<Feedback | null>(() => { try { const saved = JSON.parse(desktopStorage.getItem(key) ?? "null"); return saved?.path === path ? saved : null; } catch { return null; } });
  const [error, setError] = useState("");
  const update = (value: Feedback | null) => { setFeedback(value); try { if (value) desktopStorage.setItem(key, JSON.stringify(value)); else desktopStorage.removeItem(key); } catch (cause) { setError(String(cause)); } };
  return <><pre className="native-diff-lines">{diffRows(lines).map((row, number) => <span key={number} className={row.text.startsWith("+") && !row.text.startsWith("+++") ? "added" : row.text.startsWith("-") && !row.text.startsWith("---") ? "removed" : row.text.startsWith("@@") ? "hunk" : ""}>
    {(row.before !== undefined || row.after !== undefined) && <button className="native-diff-line-comment" aria-label={`反馈 ${path}:${row.after ?? row.before}`} title="添加行级反馈" onClick={() => update({ path, line: row.after ?? row.before!, side: row.after ? "当前文件" : "原文件", excerpt: row.text, text: "" })}>{row.before ?? ""} · {row.after ?? ""}</button>}{row.text || " "}{"\n"}
  </span>)}</pre>
    {feedback && <NativeModal title={`反馈 · ${feedback.path}:${feedback.line}`} onCancel={() => update(null)}><p className="native-muted">{feedback.side}</p><pre className="native-review-output">{feedback.excerpt}</pre><textarea aria-label="行级反馈" value={feedback.text} onChange={event => update({ ...feedback, text: event.target.value })} placeholder="说明需要调整的内容…" />{error && <p role="alert">{error}</p>}<div className="native-dialog-actions"><button onClick={() => update(null)}>取消</button><button disabled={!feedback.text.trim()} onClick={() => { session.prefill(`请根据以下审查反馈修改 ${JSON.stringify(feedback.path)}（${feedback.side}，第 ${feedback.line} 行）：\n${feedback.excerpt}\n\n${feedback.text}`); update(null); }}>加入输入框</button></div></NativeModal>}
  </>;
}
