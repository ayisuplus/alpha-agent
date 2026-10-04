/**
 * WCAG contrast for Pearl Optics token pairs, read from desktop/ui/src/styles/tokens.css.
 * Translucent tokens are composited over their real backdrop; the sidebar is checked over the plain canvas and over
 * each aurora glow at full strength, and the lowest ratio is reported.
 *
 * Usage: bun run docs/audits/2026-10-03-pearl-optics/contrast.ts
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Rgba = [number, number, number, number];
const css = await readFile(resolve(import.meta.dir, "../../../desktop/ui/src/styles/tokens.css"), "utf8");
const raw = new Map([...css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map(match => [match[1], match[2].trim()]));

function parse(value: string, theme: 0 | 1): Rgba {
  value = value.trim();
  const pair = /^light-dark\((.*)\)$/.exec(value);
  if (pair) {
    let depth = 0, split = -1;
    for (let index = 0; index < pair[1].length; index++) {
      const char = pair[1][index];
      if (char === "(") depth++; else if (char === ")") depth--; else if (char === "," && depth === 0) { split = index; break; }
    }
    return parse(theme === 0 ? pair[1].slice(0, split) : pair[1].slice(split + 1), theme);
  }
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (reference) return parse(raw.get(reference[1])!, theme);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ (\d+)%)?\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) / 100 : 1];
  throw new Error(`Unsupported colour: ${value}`);
}
const token = (name: string, theme: 0 | 1) => parse(raw.get(name) ?? (() => { throw new Error(`Missing ${name}`); })(), theme);
const over = (top: Rgba, bottom: Rgba): Rgba => [0, 1, 2].map(index => top[index] * top[3] + bottom[index] * (1 - top[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) => [r, g, b].map(channel => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const ratio = (a: Rgba, b: Rgba) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };

const rows: Array<{ theme: string; pair: string; ratio: number; minimum: number; pass: boolean }> = [];
for (const theme of [0, 1] as const) {
  const app = token("--bg-app", theme);
  const canvases = [app, over(token("--aurora-a", theme), app), over(token("--aurora-b", theme), app)];
  const surface = token("--bg-surface", theme);
  const backdrops: Record<string, Rgba[]> = {
    "bg-surface": [surface],
    "bg-elevated": [token("--bg-elevated", theme)],
    "bg-inset": [token("--bg-inset", theme)],
    "user-bubble-bg": [token("--user-bubble-bg", theme)],
    "sidebar (over canvas and aurora)": canvases.map(canvas => over(token("--bg-sidebar", theme), canvas)),
    "glass over surface": [over(token("--glass-bg", theme), surface)],
    "accent-bg over surface": [over(token("--accent-bg", theme), surface)],
  };
  const check = (fg: string, bg: string, minimum = 4.5, colour = token(fg, theme)) => {
    const value = Math.min(...backdrops[bg]!.map(backdrop => ratio(over(colour, backdrop), backdrop)));
    rows.push({ theme: theme ? "dark" : "light", pair: `${fg} on ${bg}`, ratio: Math.round(value * 100) / 100, minimum, pass: value >= minimum });
  };
  for (const bg of ["bg-surface", "bg-elevated", "bg-inset", "user-bubble-bg", "sidebar (over canvas and aurora)", "glass over surface"]) check("--text", bg);
  for (const bg of ["bg-surface", "bg-elevated", "sidebar (over canvas and aurora)", "glass over surface"]) check("--text-secondary", bg);
  for (const bg of ["bg-surface", "bg-elevated", "bg-inset", "sidebar (over canvas and aurora)", "glass over surface"]) { check("--text-muted", bg); check("--text-faint", bg); }
  for (const bg of ["bg-surface", "bg-elevated", "sidebar (over canvas and aurora)", "accent-bg over surface", "glass over surface"]) check("--accent", bg);
  for (const stop of ["--sky-300", "--sky-400", "--sky-500"]) {
    const value = ratio(token("--on-accent", theme), token(stop, theme));
    rows.push({ theme: theme ? "dark" : "light", pair: `--on-accent on ${stop} (primary gradient)`, ratio: Math.round(value * 100) / 100, minimum: 4.5, pass: value >= 4.5 });
  }
  for (const [fg, bg] of [["--success", "--success-bg"], ["--warning", "--warning-bg"], ["--danger", "--danger-bg"]] as const) {
    const value = ratio(token(fg, theme), token(bg, theme));
    rows.push({ theme: theme ? "dark" : "light", pair: `${fg} on ${bg}`, ratio: Math.round(value * 100) / 100, minimum: 4.5, pass: value >= 4.5 });
  }
  check("--focus-color", "bg-surface", 3);
  check("--focus-color", "bg-elevated", 3);
}
console.table(rows);
const failures = rows.filter(row => !row.pass);
console.log(failures.length ? `${failures.length} pair(s) below minimum` : `All ${rows.length} pairs meet their minimum`);
process.exitCode = failures.length ? 1 : 0;
