import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ITheme } from "@xterm/xterm";

/**
 * 墨·深 (alpha-ink) xterm palette: the 16 ANSI slots mirror presets/terminal-themes/alpha-ink.json
 * so a 16-color-only TUI still reads as Alpha (no truecolor dependency). Each slot takes its value
 * from the theme's vars; bright slots are the lightened variant of the same hue.
 */
const ALPHA_INK: ITheme = {
  background: "#25231f", // colors.export.pageBg
  foreground: "#fcfaf8", // colors.text
  cursor: "#fcfaf8",
  black: "#1f1d19", // colors.statusLineBg
  red: "#c96a5c", // vars.red
  green: "#8fb394", // vars.green
  yellow: "#c9a24b", // vars.yellow
  blue: "#8aa1b8", // vars.blue
  magenta: "#d8c9a8", // vars.yellow 族的亮档 (colors.mdCode)
  cyan: "#7fa6b3", // vars.cyan
  white: "#ebe5dc", // vars.accent
  brightBlack: "#6f6a61", // vars.dimGray
  brightRed: "#d98a7c",
  brightGreen: "#a7c4ab",
  brightYellow: "#d9b871",
  brightBlue: "#a4b9cd",
  brightMagenta: "#e8d9bd",
  brightCyan: "#9fc0cb",
  brightWhite: "#fcfaf8", // colors.text
};

/** Native OMP TUI in the same session; the server suspends RPC while this owns it. */
export function NativeTerminal({ id, output }: { id: string; output: string }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const written = useRef("");
  useEffect(() => {
    if (!element.current) return;
    const post = async (path: string, data: unknown) => {
      // The native server requires the bridge token on /api; window.alpha carries it.
      const token = await (window.alpha as unknown as { serverToken?: () => Promise<string> } | undefined)?.serverToken?.();
      await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { "x-alpha-token": token } : {}) },
        body: JSON.stringify(data),
      });
    };
    const xterm = new Terminal({ fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 13, theme: ALPHA_INK });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element.current);
    terminal.current = xterm;
    fit.fit();
    const input = xterm.onData(data => { void post(`/api/native/sessions/${id}/terminal/input`, { data }); });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void post(`/api/native/sessions/${id}/terminal/resize`, { cols: xterm.cols, rows: xterm.rows });
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
  return <div ref={element} className="native-terminal" aria-label="Alpha 终端" />;
}
