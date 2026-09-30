import { useEffect, useState } from "react";
import { sessionRequest } from "./native-api";
import { NativeTerminal } from "./NativeTerminal";
import type { SessionController } from "./useSession";
import { desktopStorage } from "./desktop-storage";

type Shell = { id: string; name: string; active: boolean; output: string; error?: string; exitCode?: number };
export function NativeProjectShells({ session }: { session: SessionController }) {
  const [shells, setShells] = useState<Shell[]>([]), [selected, select] = useState(() => desktopStorage.getItem(`alpha-shell:${session.selected}`) ?? "");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = async () => { const result = await sessionRequest<{ shells: Shell[] }>(session.selected!, "shells"); setShells(result.shells); select(current => result.shells.some(shell => shell.id === current) ? current : result.shells[0]?.id ?? ""); };
  useEffect(() => { let active = true; const refresh = () => { if (active) void load().catch(cause => setError(String(cause))); }; refresh(); const timer = setInterval(refresh, 1000); return () => { active = false; clearInterval(timer); }; }, [session.selected]);
  useEffect(() => { desktopStorage.setItem(`alpha-shell:${session.selected}`, selected); }, [selected, session.selected]);
  const run = async (close?: string) => { setBusy(true); setError(""); try { const result = await sessionRequest<{ id?: string }>(session.selected!, close ? `shells/${close}/close` : "shells", {}); if (result.id) select(result.id); await load(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } };
  const shell = shells.find(item => item.id === selected);
  return <section className="native-terminal-panel">
    <div className="native-panel"><h3>项目终端</h3><p className="native-muted">独立 PowerShell，可与对话并行。收起面板后继续运行；应用退出后关闭。</p>
      <div className="native-file-actions"><button disabled={busy || shells.length >= 8} onClick={() => void run()}>新终端</button>{shell && <button disabled={busy} onClick={() => void run(shell.id)}>关闭此终端</button>}</div>
      <nav className="native-file-tabs" aria-label="终端标签">{shells.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => select(item.id)}>{item.name}{!item.active ? " · 已退出" : ""}</button>)}</nav>
      {(error || shell?.error) && <p role="alert">{error || shell?.error}</p>}
      {shell && !shell.active && <p className="native-muted">退出码：{shell.exitCode ?? "未知"}</p>}
    </div>
    {shell && <NativeTerminal key={shell.id} id={session.selected!} channel={`shells/${shell.id}`} output={shell.output} onError={session.setError} />}
  </section>;
}
