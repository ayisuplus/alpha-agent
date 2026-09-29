import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** Native OMP TUI in the same session; the server suspends RPC while this owns it. */
export function NativeTerminal({ id, output }: { id: string; output: string }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const written = useRef("");
  useEffect(() => {
    if (!element.current) return;
    const xterm = new Terminal({ fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 13, theme: { background: "#25231f", foreground: "#f4eee6", cursor: "#f4eee6" } });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element.current);
    terminal.current = xterm;
    fit.fit();
    const input = xterm.onData(data => { void fetch(`/api/native/sessions/${id}/terminal/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) }); });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void fetch(`/api/native/sessions/${id}/terminal/resize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: xterm.cols, rows: xterm.rows }) });
    });
    resize.observe(element.current);
    xterm.focus();
    return () => { input.dispose(); resize.disconnect(); xterm.dispose(); terminal.current = null; written.current = ""; };
  }, [id]);
  useEffect(() => {
    if (!terminal.current) return;
    if (output.startsWith(written.current)) terminal.current.write(output.slice(written.current.length));
    else { terminal.current.reset(); terminal.current.write(output); }
    written.current = output;
  }, [output]);
  return <div ref={element} className="native-terminal" aria-label="OMP 原生终端" />;
}
