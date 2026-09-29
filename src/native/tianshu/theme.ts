/**
 * Tianshu status wording shared by the terminal footer and the desktop top bar
 * (RPC-forwarded `setStatus("tianshu", …)`).
 */

import type { SignalKey, SignalRecord } from "./signals";
import type { TianshuState } from "./state";

const STATUS_PRIORITY: readonly SignalKey[] = [
  "repeat-failure",
  "claim-mismatch",
  "verification-debt",
  "model-fallback",
];

const STATUS_TEXT: Readonly<Record<string, string>> = {
  "repeat-failure": "天枢 · 重复失败",
  "claim-mismatch": "天枢 · 宣称待证",
  "verification-debt": "天枢 · 改后未验证",
  "model-fallback": "天枢 · 模型降级",
};

/**
 * `天枢 ✓` / `天枢 · 改后未验证` / `天枢 · 宣称待证` / `天枢 · 重复失败`
 * (…), with measured context usage always appended.
 */
export function statusText(state: TianshuState, signals: readonly SignalRecord[]): string {
  let text = "天枢 ✓";
  for (const key of STATUS_PRIORITY) {
    const hit = signals.find(signal => signal.key === key);
    if (hit !== undefined) {
      text = STATUS_TEXT[hit.key] ?? text;
      break;
    }
  }
  return state.contextPercent === null ? text : `${text} · 上下文 ${state.contextPercent}%`;
}

// ── 8.1 终端差异化：Alpha 页眉/标题措辞与 /alpha 概况正文（纯加法）──

/** Everything the Alpha header row shows; resolved by the extension before rendering. */
export interface AlphaChromeInfo {
  model: string | undefined;
  thinkingLevel: string | undefined;
  cwd: string | undefined;
  sessionName: string | undefined;
}

/** `/alpha` report body inputs; tool registration only, never machine probing. */
export interface AlphaReportInfo {
  version: string;
  skills: readonly string[];
  capabilities: readonly { name: string; registered: boolean }[];
  otherAlphaTools: readonly string[];
  commands: readonly string[];
}

const THINKING_LABEL: Readonly<Record<string, string>> = {
  inherit: "继承",
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "极限",
};

/**
 * `α Alpha · 天枢 | <模型> · 思考<强度> | <项目目录> | <会话名>` — one header row;
 * the model/cwd/session segments appear only when known.
 */
export function alphaHeaderLine(info: AlphaChromeInfo): string {
  const model = info.model ?? "模型未定";
  const thinking = info.thinkingLevel === undefined ? undefined : THINKING_LABEL[info.thinkingLevel] ?? info.thinkingLevel;
  const segments = ["α Alpha · 天枢", thinking === undefined ? model : `${model} · 思考${thinking}`];
  if (info.cwd !== undefined && info.cwd.length > 0) segments.push(info.cwd);
  if (info.sessionName !== undefined && info.sessionName.length > 0) segments.push(info.sessionName);
  return segments.join(" | ");
}

/** `Alpha · <会话名>`; bare `Alpha` before the session is named. */
export function alphaTitle(sessionName: string | undefined): string {
  return sessionName !== undefined && sessionName.length > 0 ? `Alpha · ${sessionName}` : "Alpha";
}

/** `/alpha` body: installed Alpha Skills, capability tool registration, version. */
export function alphaReport(info: AlphaReportInfo): string {
  return [
    "α Alpha 本机概况",
    `版本 ${info.version}`,
    `已装 Alpha Skill（${info.skills.length}）：${info.skills.length > 0 ? info.skills.join("、") : "无"}`,
    "本机能力（只报工具在册与否；LibreOffice/ComfyUI 实机探测见“本机能力”页）：",
    ...info.capabilities.map(item => `  ${item.name}：${item.registered ? "在册" : "未在册"}`),
    `其它 alpha_* 工具（${info.otherAlphaTools.length}）：${
      info.otherAlphaTools.length > 0 ? info.otherAlphaTools.join("、") : "无"
    }`,
    `扩展命令：${info.commands.length > 0 ? info.commands.map(name => `/${name}`).join("、") : "无"}`,
  ].join("\n");
}
