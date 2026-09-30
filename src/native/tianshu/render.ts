/**
 * Text rendering for the Tianshu layer: model/user reminders, the post-compact
 * reanchor note, the `/tianshu` evidence frame panel and the transcript message
 * body. Model-facing prose carries no evidence hashes ("由你判断"); evidence
 * (command summaries, failure signature, time order) rides in `details`.
 */

import type { SignalRecord } from "./signals";
import type { EvidenceFrame, TianshuState } from "./state";

export interface MessagePayload {
  content: string;
  details: unknown;
}

function evidenceDetails(state: TianshuState, label: string): unknown {
  return {
    layer: "tianshu",
    label,
    failureSignature: state.failure?.signature ?? null,
    lastMutation: state.lastMutation,
    lastVerification: state.lastVerification,
    timeline: state.recent.map(note => `${note.seq} ${note.kind} ${note.summary}`),
  };
}

const REMINDER_BY_SIGNAL: Readonly<Record<string, (state: TianshuState) => string>> = {
  "repeat-failure": state =>
    `【检查建议】同类工具错误连续出现（同一错误签名 ${state.failure?.count ?? 2} 次）。建议先检查原因，再决定是否换方法；由你判断。`,
  "verification-debt": () =>
    "【检查建议】改了代码文件，还没有看到这之后完成的验证（测试/类型检查/lint）。建议验证受影响的行为；由你判断。",
  "claim-mismatch": state =>
    [
      "【检查建议】宣称与证据对账（提醒，不拦截）：",
      ...state.claimIssues.map(issue => issue.line),
      "由你判断。",
    ].join("\n"),
  "todo-verification-gap": () =>
    "【检查建议】待办已全部完成，但仍有未验证的代码改动。建议补上验证再收尾；由你判断。",
};

export function renderReminder(signal: SignalRecord, state: TianshuState): MessagePayload {
  const render = REMINDER_BY_SIGNAL[signal.key];
  const content =
    render !== undefined
      ? render(state)
      : "【检查建议】有一条新的观察记录，请查看 /tianshu；由你判断。";
  return { content, details: evidenceDetails(state, signal.key) };
}

/** Reanchor sections: goal, open todos, unresolved verification debt, claim issues. */
export function reanchorSections(state: TianshuState): string[] {
  const sections: string[] = [];
  if (state.goal !== null) sections.push(`当前目标：${state.goal}`);
  const openTodos = state.todos === null ? [] : state.todos.filter(todo => !todo.done);
  if (openTodos.length > 0) sections.push(`未完待办：${openTodos.map(todo => todo.content).join("；")}`);
  const unverifiedMutation =
    state.lastMutation !== null &&
    (state.lastVerification === null || state.lastVerification.seq < state.lastMutation.seq);
  if (unverifiedMutation) sections.push(`未解决验证债：${state.lastMutation?.target ?? "代码改动"} 尚未验证`);
  if (state.claimIssues.length > 0) sections.push(`宣称问题：${state.claimIssues.map(issue => issue.kind).join("、")}`);
  return sections;
}

/** Post-compact reanchor, sent exactly once per compaction. */
export function renderReanchor(state: TianshuState): MessagePayload {
  const sections = reanchorSections(state);
  const content =
    sections.length > 0
      ? `【检查建议】上下文压缩后重锚，请核对以下事实；由你判断。\n${sections.map(section => `- ${section}`).join("\n")}`
      : "【检查建议】上下文压缩后重锚：当前没有记录的目标、待办、验证债或宣称问题。";
  return { content, details: evidenceDetails(state, "compact-reanchor") };
}

/** `/tianshu` panel: facts, signals, evidence sources, measurement quality. */
export function renderPanel(frame: EvidenceFrame): string {
  const lines: string[] = ["运行证据帧"];
  lines.push("事实", `  轮次 ${frame.facts.turn} · 事件 ${frame.facts.events}`);
  lines.push(
    `  最后变异 ${frame.facts.lastMutation === null ? "无" : `seq ${frame.facts.lastMutation.seq} ${frame.facts.lastMutation.target}`}`,
  );
  lines.push(
    `  最后验证 ${frame.facts.lastVerification === null ? "无" : `seq ${frame.facts.lastVerification.seq} ${frame.facts.lastVerification.command} ✓（${frame.facts.lastVerification.family} 族）`}`,
  );
  lines.push(`  未验证变异 ${frame.facts.unverifiedMutation ? "有" : "无"}`);
  lines.push(`  宣称 ${frame.facts.claimedKinds.length === 0 ? "无" : frame.facts.claimedKinds.join("、")}`);
  lines.push(
    `  宣称问题 ${frame.facts.claimIssueKinds.length === 0 ? "无" : frame.facts.claimIssueKinds.join("、")}`,
  );
  if (frame.facts.failure !== null) {
    lines.push(`  重复失败 ${frame.facts.failure.toolName} 同签名 ${frame.facts.failure.count} 次（${frame.facts.failure.signature}）`);
  }
  if (frame.facts.todos !== null) lines.push(`  待办 ${frame.facts.todos.open}/${frame.facts.todos.total} 未完`);
  if (frame.facts.goal !== null) lines.push(`  目标 ${frame.facts.goal}`);
  if (frame.facts.modelFallback !== null) {
    lines.push(`  模型降级 ${frame.facts.modelFallback.from} → ${frame.facts.modelFallback.to}`);
  }
  lines.push("信号", ...(frame.signals.length === 0 ? ["  无"] : frame.signals.map(signal => `  ${signal.key}（${signal.token}）`)));
  lines.push("证据来源", ...(frame.sources.length === 0 ? ["  无"] : frame.sources.map(source => `  ${source}`)));
  lines.push(
    `测量质量  工具结果 ${frame.quality.toolResults} · 验证 ${frame.quality.verification} · 上下文 ${frame.quality.context}${
      frame.facts.contextPercent === null ? "" : `（${frame.facts.contextPercent}%）`
    }`,
  );
  return lines.join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter(line => line.length > 0)
      .join("\n");
  }
  return "";
}

/** Transcript message body: the tianshu vertical-bar style, distinct from OMP advisor. */
export function renderMessageLines(content: unknown, details: unknown, expanded: boolean): string[] {
  const text = textOf(content);
  const lines = text.split("\n").filter(line => line.length > 0);
  const framed = lines.map((line, index) => (index === 0 && !line.includes("运行检查") ? `▌ 运行检查 · ${line}` : `▌ ${line}`));
  if (!expanded || typeof details !== "object" || details === null) return framed;
  const timeline = (details as { timeline?: unknown }).timeline;
  if (!Array.isArray(timeline)) return framed;
  return [...framed, ...timeline.map(entry => `▌   ${String(entry)}`)];
}
