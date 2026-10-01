import { t } from "./ui-language";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ITheme } from "@xterm/xterm";
import { sessionRequest } from "./native-api";
import sky from "../../../../presets/terminal-themes/alpha-sky.json";

/**
 * Alpha xterm palette: the 16 ANSI slots read presets/terminal-themes/alpha-sky.json
 * so a 16-color-only TUI still reads as Alpha (no truecolor dependency). Each slot takes its value
 * from the theme's vars, including bright slots.
 */
const ALPHA_SKY: ITheme = {
  background: sky.export.pageBg,
  foreground: sky.colors.text,
  cursor: sky.vars.cyan,
  black: sky.colors.statusLineBg,
  red: sky.vars.red,
  green: sky.vars.green,
  yellow: sky.vars.yellow,
  blue: sky.vars.blue,
  magenta: sky.colors.mdCode,
  cyan: sky.vars.cyan,
  white: sky.vars.accent,
  brightBlack: sky.vars.gray,
  brightRed: sky.vars.red,
  brightGreen: sky.vars.green,
  brightYellow: sky.vars.yellow,
  brightBlue: sky.vars.blue,
  brightMagenta: sky.colors.mdCode,
  brightCyan: sky.vars.cyan,
  brightWhite: sky.colors.text,
};

/** Native OMP TUI in the same session; the server suspends RPC while this owns it. */
export function NativeTerminal({ id, output, onError, channel = "terminal" }: { id: string; output: string; onError(value: string): void; channel?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const written = useRef("");
  useEffect(() => {
    if (!element.current) return;
    let active = true;
    const post = (action: string, data: unknown) => sessionRequest(id, `${channel}/${action}`, data).catch(cause => { if (active) onError(String(cause)); });
    const xterm = new Terminal({ fontFamily: "Cascadia Code, Consolas, monospace", fontSize: 13, theme: ALPHA_SKY });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element.current);
    terminal.current = xterm;
    fit.fit();
    const input = xterm.onData(data => { void post("input", { data }); });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void post("resize", { cols: xterm.cols, rows: xterm.rows });
    });
    resize.observe(element.current);
    xterm.focus();
    return () => { active = false; input.dispose(); resize.disconnect(); xterm.dispose(); terminal.current = null; written.current = ""; };
  }, [id, onError, channel]);
  useEffect(() => {
    if (!terminal.current) return;
    if (output.startsWith(written.current)) terminal.current.write(output.slice(written.current.length));
    else { terminal.current.reset(); terminal.current.write(output); }
    written.current = output;
  }, [output]);
  return <div ref={element} className="native-terminal" aria-label={t("Alpha 终端")} />;
}
