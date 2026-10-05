import { useState } from "react";
import { nativeApi } from "./native-api";
import { t } from "./ui-language";

export function NativeLogs({ sessionId }: { sessionId: string | null }) {
  const [entries, setEntries] = useState<Array<{ name: string; size: number; modifiedAt: string }>>([]), [text, setText] = useState(""), [error, setError] = useState("");
  const request = <T,>(input: Record<string, unknown>) => nativeApi<T>(`sessions/${sessionId}/host/session`, { action: "logs", ...input });
  return <details><summary>{t("持久诊断日志")}</summary><p>{t("读取原生运行时已有日志，最多显示末尾 256 KiB；敏感字段经过遮罩。")}</p>
    {!sessionId && <p>{t("请先打开一个会话，读取实际运行时。")}</p>}
    <button disabled={!sessionId} onClick={() => void request<{ entries: typeof entries }>({}).then(value => { setEntries(value.entries); setError(""); }, cause => setError(String(cause)))}>{t("读取日志目录")}</button>
    {entries.map(row => <div key={row.name}><button onClick={() => void request<{ text: string }>({ name: row.name }).then(value => { setText(value.text); setError(""); }, cause => setError(String(cause)))}>{row.name}</button><small> · {row.size} B · {row.modifiedAt}</small></div>)}
    {error && <p role="alert">{error}</p>}<pre className="native-code-block">{text}</pre>
  </details>;
}
