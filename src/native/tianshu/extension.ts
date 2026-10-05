/**
 * Tianshu evidence layer — assembles the pure core onto OMP's native events,
 * session and panel. Reads OMP native events, writes OMP native session
 * (`appendEntry`) and panel (`setStatus`, message renderer, `/tianshu`).
 * Advisory only: it never intercepts tools and never starts a turn by itself.
 *
 * ALPHA_CVM_MODE=shadow records state and snapshots but sends nothing;
 * ALPHA_CVM_MODE=off disables the layer entirely.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  applyEvent,
  buildFrame,
  emptyState,
  evidenceDigest,
  rebuildFromEntries,
  summaryChanged,
  toSnapshot,
  type SessionEntryLike,
  type TianshuEvent,
  type TianshuState,
} from "./state";
import { renderMessageLines, renderPanel, renderReminder, renderReanchor, reanchorSections } from "./render";
import { alphaHeaderLine, alphaReport, alphaTitle, statusText } from "./theme";

const SNAPSHOT_TYPE = "alpha-tianshu";

interface PendingCall {
  toolName: string;
  command?: string;
  path?: string;
}

interface SendOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn" | "aside";
}

/** Structural view of the OMP extension context this layer uses. */
interface TianshuContext {
  agent: { kind: string };
  ui: { setStatus(key: string, text: string | undefined): void };
  sessionManager: { getEntries(): readonly SessionEntryLike[]; getLeafId(): string | null | undefined };
  getContextUsage(): { percent: number } | undefined;
  isIdle(): boolean;
}

function pickPath(input: Record<string, unknown>): string | undefined {
  const direct = input.path ?? input.file_path;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const list = input.paths;
  if (Array.isArray(list) && typeof list[0] === "string") return list[0];
  return undefined;
}

function textOfContent(content: readonly { type: string; text?: unknown }[]): string {
  return content
    .filter(part => part.type === "text")
    .map(part => String(part.text ?? ""))
    .join("\n");
}

export default function tianshuEvidenceLayer(pi: ExtensionAPI): void {
  const mode =
    process.env.ALPHA_CVM_MODE === "off" ? "off" : process.env.ALPHA_CVM_MODE === "shadow" ? "shadow" : "active";
  if (mode === "off") return;
  // 8.1 终端差异化（纯加法）：Alpha 页眉、标题与 /alpha；不动上方天枢逻辑。
  registerAlphaChrome(pi);

  let state: TianshuState = emptyState();
  const pendingCalls = new Map<string, PendingCall>();

  function updateStatus(ctx: TianshuContext): void {
    ctx.ui.setStatus("tianshu", statusText(state, buildFrame(state).signals));
  }

  /** Fold one event; persist a snapshot when the summary changed. */
  function observe(event: TianshuEvent, ctx: TianshuContext): void {
    const before = state;
    state = applyEvent(state, event).state;
    if (summaryChanged(before, state)) {
      pi.appendEntry(SNAPSHOT_TYPE, toSnapshot(state));
      updateStatus(ctx);
    }
  }

  /** Signal reminders and the post-compaction reanchor. Idle delivery never triggers a turn. */
  function deliver(ctx: TianshuContext, payload: { content: string; details: unknown }): void {
    if (mode === "shadow") return;
    const options: SendOptions = ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "aside" };
    pi.sendMessage(
      { customType: SNAPSHOT_TYPE, content: payload.content, display: true, details: payload.details },
      options,
    );
  }

  function rebuild(ctx: TianshuContext): void {
    state = rebuildFromEntries(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
    pendingCalls.clear();
    updateStatus(ctx);
  }

  function isMain(ctx: TianshuContext): boolean {
    return ctx.agent.kind === "main";
  }

  pi.on("session_start", (_event, ctx) => {
    if (isMain(ctx)) rebuild(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    if (isMain(ctx)) rebuild(ctx);
  });
  pi.on("session_branch", (_event, ctx) => {
    if (isMain(ctx)) rebuild(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (isMain(ctx)) rebuild(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!isMain(ctx)) return;
    const message = event.message;
    if (message.role !== "assistant") return;
    for (const part of message.content) {
      if (part.type === "toolCall") {
        const args = part.arguments as Record<string, unknown>;
        const command = typeof args.command === "string" ? args.command : undefined;
        pendingCalls.set(part.id, { toolName: part.name, command, path: pickPath(args) });
      }
    }
    const text = textOfContent(message.content);
    if (text.length > 0) observe({ type: "assistant-message", at: Date.now(), text }, ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    if (!isMain(ctx)) return;
    const call = pendingCalls.get(event.toolCallId);
    pendingCalls.delete(event.toolCallId);
    const input = event.input as Record<string, unknown>;
    observe(
      {
        type: "tool-result",
        at: Date.now(),
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        command: typeof input.command === "string" ? input.command : call?.command,
        path: pickPath(input) ?? call?.path,
        errorDigest: event.isError ? evidenceDigest(`${event.toolName}:${textOfContent(event.content)}`) : undefined,
      },
      ctx,
    );
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!isMain(ctx)) return;
    const usage = ctx.getContextUsage();
    const at = Date.now();
    state = applyEvent(state, { type: "context-usage", at, percent: usage === undefined ? null : usage.percent }).state;
    const result = applyEvent(state, { type: "turn-end", at });
    state = result.state;
    pi.appendEntry(SNAPSHOT_TYPE, toSnapshot(state));
    updateStatus(ctx);
    for (const item of result.outbound) {
      deliver(ctx, item.kind === "reanchor" ? renderReanchor(state) : renderReminder(item.signal, state));
    }
  });

  pi.on("goal_updated", (event, ctx) => {
    if (!isMain(ctx)) return;
    observe({ type: "goal", at: Date.now(), objective: event.goal === null ? null : event.goal.objective }, ctx);
  });

  pi.on("todo_reminder", (event, ctx) => {
    if (!isMain(ctx)) return;
    observe(
      {
        type: "todos",
        at: Date.now(),
        items: event.todos.map(todo => ({
          content: todo.content,
          done: todo.status === "completed" || todo.status === "abandoned",
        })),
      },
      ctx,
    );
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!isMain(ctx)) return;
    observe({ type: "compact", at: Date.now() }, ctx);
  });

  pi.on("session.compacting", (_event, ctx) => {
    if (!isMain(ctx)) return;
    const sections = reanchorSections(state);
    return sections.length > 0 ? { context: sections } : undefined;
  });

  pi.on("retry_fallback_applied", (event, ctx) => {
    if (!isMain(ctx)) return;
    observe({ type: "model-fallback", at: Date.now(), from: event.from, to: event.to }, ctx);
  });

  pi.on("retry_fallback_succeeded", (_event, ctx) => {
    if (!isMain(ctx)) return;
    observe({ type: "model-fallback-resolved", at: Date.now() }, ctx);
  });

  pi.registerMessageRenderer(SNAPSHOT_TYPE, (message, options) => ({
    render: (width: number) => {
      const rows: string[] = [];
      for (const line of renderMessageLines(message.content, message.details, options.expanded)) {
        for (let rest = line; rest.length > 0; rest = rest.slice(Math.max(1, width))) {
          rows.push(rest.slice(0, Math.max(1, width)));
        }
      }
      return rows;
    },
  }));

  pi.registerCommand("tianshu", {
    description: "展开天枢证据帧（事实、信号、证据来源、测量质量）",
    handler: async (_args, _ctx) => {
      const panel: SendOptions = { triggerTurn: false };
      pi.sendMessage(
        {
          customType: SNAPSHOT_TYPE,
          content: renderPanel(buildFrame(state)),
          display: true,
          details: { layer: "tianshu", label: "panel" },
        },
        panel,
      );
    },
  });
}

// ── 8.1 终端差异化（纯加法）：Alpha 页眉、标题与 /alpha 命令 ──────────────────
//
// 与证据层同门（ALPHA_CVM_MODE=off 时整个扩展不注册任何东西）。页眉/标题在 RPC 模式下
// 由宿主按契约自动降级（setHeader 是 no-op；setTitle 仅 PI_RPC_EMIT_TITLE 转发）。

const REPORT_TYPE = "alpha-report";
const CAPABILITY_TOOLS = ["alpha_office", "alpha_generate_image", "alpha_generate_voice", "alpha_generate_video"];

/** Repository root: this file lives at <root>/src/native/tianshu/extension.ts. */
const appRoot = resolve(import.meta.dir, "..", "..", "..");

function registerAlphaChrome(pi: ExtensionAPI): void {
  const shown = { line: "", title: "" };

  /** Header/title follow the model and session name; re-set only when the text changed. */
  function refreshChrome(ctx: ExtensionContext): void {
    if (typeof ctx.ui.setHeader !== "function" || typeof ctx.ui.setTitle !== "function") return;
    const line = alphaHeaderLine({
      model: ctx.model === undefined ? undefined : ctx.model.name,
      thinkingLevel: pi.getThinkingLevel(),
      cwd: ctx.cwd,
      sessionName: pi.getSessionName(),
    });
    const title = alphaTitle(pi.getSessionName());
    if (line !== shown.line) {
      shown.line = line;
      const rows: readonly string[] = [line];
      // setHeader is the contract channel but a no-op in OMP 18.4.3's TUI; the widget mirror
      // keeps the row visible today. Drop the mirror once setHeader renders.
      ctx.ui.setHeader(() => ({ render: () => rows }));
      if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget("alpha-header", [line], { placement: "aboveEditor" });
    }
    if (title !== shown.title) {
      shown.title = title;
      ctx.ui.setTitle(title);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.ALPHA_TERMINAL_THEME === "1" && ctx.agent.kind === "main") {
      const result = await ctx.ui.setTheme("alpha-sky");
      if (!result.success) ctx.ui.notify(`无法载入 Alpha 终端主题：${result.error ?? "未知原因"}`, "warning");
    }
    refreshChrome(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    refreshChrome(ctx);
  });
  pi.on("session_branch", (_event, ctx) => {
    refreshChrome(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    refreshChrome(ctx);
  });
  // Model and session-name changes land in the header at the next turn boundary.
  pi.on("turn_start", (_event, ctx) => {
    refreshChrome(ctx);
  });

  pi.registerMessageRenderer(REPORT_TYPE, message => ({
    render: (width: number) => {
      const text = typeof message.content === "string" ? message.content : "";
      const rows: string[] = [];
      for (const line of text.split("\n").filter(row => row.length > 0)) {
        for (let rest = line; rest.length > 0; rest = rest.slice(Math.max(1, width))) {
          rows.push(rest.slice(0, Math.max(1, width)));
        }
      }
      return rows;
    },
  }));

  pi.registerCommand("alpha", {
    description: "Alpha 本机概况：已装 Skill、本机能力工具在册情况与版本",
    handler: async (_args, _ctx) => {
      const skills = await readdir(join(appRoot, "presets", "alpha-plugin", "skills"), { withFileTypes: true })
        .then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
        .catch(() => [] as string[]);
      const version = await readFile(join(appRoot, "package.json"), "utf8")
        .then(text => {
          const parsed = JSON.parse(text) as { version?: unknown };
          return typeof parsed.version === "string" ? parsed.version : "未知（package.json 未声明 version）";
        })
        .catch(() => "未知（package.json 未声明 version）");
      const tools = pi.getAllTools().map(tool => tool.name);
      const alphaTools = tools.filter(name => name.startsWith("alpha_"));
      pi.sendMessage(
        {
          customType: REPORT_TYPE,
          display: true,
          details: { layer: "alpha", label: "report" },
          content: alphaReport({
            version,
            skills,
            capabilities: CAPABILITY_TOOLS.map(name => ({ name, registered: tools.includes(name) })),
            otherAlphaTools: alphaTools.filter(name => !CAPABILITY_TOOLS.includes(name)).sort(),
            commands: pi.getCommands().filter(command => command.source === "extension").map(command => command.name),
          }),
        },
        { triggerTurn: false },
      );
    },
  });
}
