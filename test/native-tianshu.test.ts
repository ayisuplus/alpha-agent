import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import tianshuEvidenceLayer from "../src/native/tianshu/extension";
import {
  classifyVerificationFamilies,
  isCodeMutationPath,
  isGitMutationCommand,
} from "../src/native/tianshu/change-class";
import { detectClaims } from "../src/native/tianshu/claims";
import { renderMessageLines, renderReminder, renderReanchor } from "../src/native/tianshu/render";
import { evaluateSignals } from "../src/native/tianshu/signals";
import {
  applyEvent,
  buildFrame,
  emptyState,
  rebuildFromEntries,
  toSnapshot,
  type SessionEntryLike,
  type TianshuEvent,
  type TianshuState,
} from "../src/native/tianshu/state";
import { statusText } from "../src/native/tianshu/theme";

const keys = (state: TianshuState) => evaluateSignals(state).map(signal => signal.key);

const writeOk = (path: string, at = 1): TianshuEvent => ({
  type: "tool-result",
  at,
  toolName: "write",
  toolCallId: `w${at}`,
  isError: false,
  path,
});

const bashOk = (command: string, at = 1): TianshuEvent => ({
  type: "tool-result",
  at,
  toolName: "bash",
  toolCallId: `b${at}`,
  isError: false,
  command,
});

const bashFail = (command: string, errorDigest: string, at = 1): TianshuEvent => ({
  type: "tool-result",
  at,
  toolName: "bash",
  toolCallId: `f${at}`,
  isError: true,
  command,
  errorDigest,
});

const claim = (text: string, at = 1): TianshuEvent => ({ type: "assistant-message", at, text });

function fold(state: TianshuState, ...events: TianshuEvent[]): TianshuState {
  let current = state;
  for (const event of events) current = applyEvent(current, event).state;
  return current;
}

// ── pi stub (delivery parameter assertions) ──

interface StubContext {
  agent: { kind: string };
  ui: { setStatus(key: string, text: string | undefined): void };
  sessionManager: { getEntries(): readonly SessionEntryLike[]; getLeafId(): string | null };
  getContextUsage(): { percent: number } | undefined;
  isIdle(): boolean;
}

function makeCtx(options: { idle?: boolean; kind?: string; entries?: SessionEntryLike[]; leafId?: string | null; usage?: { percent: number } } = {}) {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx: StubContext = {
    agent: { kind: options.kind ?? "main" },
    ui: { setStatus: (key, text) => void statuses.push({ key, text }) },
    sessionManager: { getEntries: () => options.entries ?? [], getLeafId: () => options.leafId ?? null },
    getContextUsage: () => options.usage,
    isIdle: () => options.idle ?? true,
  };
  return { ctx, statuses };
}

function stubPi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sent: Array<{ payload: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const renderers = new Map<string, unknown>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const previous = handlers.get(name);
      handlers.set(name, previous ? (event, ctx) => Promise.all([previous(event, ctx), handler(event, ctx)]) : handler);
    },
    sendMessage(payload: Record<string, unknown>, options?: Record<string, unknown>) {
      sent.push({ payload, options: options ?? {} });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    registerMessageRenderer(customType: string, renderer: unknown) {
      renderers.set(customType, renderer);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers, sent, entries, commands, renderers };
}

function fire(handlers: Map<string, (event: unknown, ctx: unknown) => unknown>, name: string, event: unknown, ctx: unknown): void {
  const handler = handlers.get(name);
  expect(handler).toBeDefined();
  handler?.(event, ctx);
}

test("Alpha terminal theme applies only when the launcher offers it", async () => {
  const previous = process.env.ALPHA_TERMINAL_THEME;
  const themes: string[] = [];
  const { pi, handlers } = stubPi();
  const { ctx } = makeCtx();
  const terminalCtx = { ...ctx, ui: { ...ctx.ui, setTheme: async (name: string) => { themes.push(name); return { success: true }; } } };
  try {
    tianshuEvidenceLayer(pi);
    delete process.env.ALPHA_TERMINAL_THEME;
    await handlers.get("session_start")?.({}, terminalCtx);
    expect(themes).toEqual([]);
    process.env.ALPHA_TERMINAL_THEME = "1";
    await handlers.get("session_start")?.({}, terminalCtx);
    expect(themes).toEqual(["alpha-sky"]);
    await handlers.get("session_start")?.({}, { ...terminalCtx, agent: { kind: "subagent" } });
    expect(themes).toEqual(["alpha-sky"]);
  } finally {
    if (previous === undefined) delete process.env.ALPHA_TERMINAL_THEME;
    else process.env.ALPHA_TERMINAL_THEME = previous;
  }
});

describe("天枢证据层 · 变更分类", () => {
  test("写 .md 不产生验证债，写 .ts 产生", () => {
    const docs = fold(emptyState(), writeOk("docs/README.md"), writeOk("notes.txt"), writeOk("config.yml"));
    expect(keys(docs)).not.toContain("verification-debt");
    expect(isCodeMutationPath("docs/README.md")).toBe(false);
    const code = fold(emptyState(), writeOk("src/foo.ts"));
    expect(keys(code)).toContain("verification-debt");
    for (const tool of ["edit", "ast_edit"] as const) {
      const via = fold(emptyState(), { type: "tool-result", at: 1, toolName: tool, toolCallId: tool, isError: false, path: "src/foo.ts" });
      expect(keys(via)).toContain("verification-debt");
    }
    const failedWrite = fold(emptyState(), {
      type: "tool-result",
      at: 1,
      toolName: "write",
      toolCallId: "x",
      isError: true,
      path: "src/foo.ts",
    });
    expect(keys(failedWrite)).not.toContain("verification-debt");
    expect(isGitMutationCommand("git commit -m x")).toBe(true);
    expect(isGitMutationCommand("git stash pop")).toBe(true);
    expect(isGitMutationCommand("git status")).toBe(false);
    expect(isGitMutationCommand("git stash list")).toBe(false);
  });

  test("只有成功的观察能解除验证债", () => {
    const edited = fold(emptyState(), writeOk("src/foo.ts"));
    expect(keys(edited)).toContain("verification-debt");
    const failedCheck = fold(edited, bashFail("bun test", "same-signature"));
    expect(keys(failedCheck)).toContain("verification-debt");
    const passed = fold(failedCheck, bashOk("bun test ./test", 2));
    expect(keys(passed)).not.toContain("verification-debt");
    expect(classifyVerificationFamilies("bun test ./test")).toEqual(["test"]);
    expect(classifyVerificationFamilies("bun run check")).toEqual(["type"]);
    expect(classifyVerificationFamilies("tsc --noEmit")).toEqual(["type"]);
    expect(classifyVerificationFamilies("eslint .")).toEqual(["lint"]);
    expect(classifyVerificationFamilies("cargo clippy")).toEqual(["type", "lint"]);
    expect(classifyVerificationFamilies("echo test")).toEqual([]);
  });
});

describe("天枢证据层 · 宣称对账", () => {
  test("宣称“全绿”无新鲜测试证据 → claim-mismatch 提醒，补验证后解除", () => {
    let state = fold(emptyState(), writeOk("src/foo.ts"), claim("改动完成，测试全绿。"));
    expect(detectClaims("改动完成，测试全绿。")).toEqual(["test"]);
    const turn = applyEvent(state, { type: "turn-end", at: 2 });
    expect(keys(turn.state)).toContain("claim-mismatch");
    const reminder = turn.outbound.find(item => item.kind === "reminder" && item.signal.key === "claim-mismatch");
    expect(reminder).toBeDefined();
    state = fold(turn.state, bashOk("bun test", 3));
    expect(keys(state)).not.toContain("claim-mismatch");
  });

  test("类型检查成功不能背书测试宣称", () => {
    const state = fold(
      emptyState(),
      writeOk("src/foo.ts"),
      bashOk("tsc --noEmit", 2),
      claim("typecheck 干净，测试也全绿。"),
    );
    expect(keys(state)).toContain("claim-mismatch");
    const issue = state.claimIssues.find(item => item.kind === "test");
    expect(issue?.line).toContain("typecheck 干净证明不了测试通过");
    // 行为宣称“已修复”同属测试族；lint 宣称需 lint 族
    const lintClaim = fold(emptyState(), bashOk("eslint .", 1), claim("lint 干净。"));
    expect(keys(lintClaim)).not.toContain("claim-mismatch");
    const lintBackedTestClaim = fold(emptyState(), bashOk("eslint .", 1), claim("全绿。"));
    expect(keys(lintBackedTestClaim)).toContain("claim-mismatch");
    const fixedClaim = fold(emptyState(), writeOk("src/foo.ts"), claim("已修复。"));
    expect(keys(fixedClaim)).toContain("claim-mismatch");
  });
});

describe("天枢证据层 · 分叉与重建", () => {
  test("从条目序列重建 == 连续运行状态（含 branch 回退）", () => {
    const script: TianshuEvent[] = [
      writeOk("src/foo.ts", 1),
      bashFail("bun test", "sig-a", 2),
      { type: "turn-end", at: 3 },
      bashFail("bun test", "sig-a", 4),
      { type: "turn-end", at: 5 },
    ];
    let continuous = emptyState();
    const entries: SessionEntryLike[] = [];
    const snapshots: TianshuState[] = [];
    for (const event of script) {
      const result = applyEvent(continuous, event);
      continuous = result.state;
      if (event.type === "turn-end") {
        snapshots.push(continuous);
        entries.push({
          id: `e${entries.length + 1}`,
          parentId: entries.length === 0 ? null : `e${entries.length}`,
          type: "custom",
          customType: "alpha-tianshu",
          data: toSnapshot(continuous),
        });
      }
    }
    // 连续运行状态等同于从条目重建的状态
    expect(rebuildFromEntries(entries)).toEqual(continuous);
    expect(rebuildFromEntries(entries, "e2")).toEqual(continuous);
    // branch 回退：从 e1 分叉后，被放弃分支上的 e2 快照不得泄漏进来
    const rolledBack = rebuildFromEntries(entries, "e1");
    expect(rolledBack).toEqual(snapshots[0]);
    expect(rolledBack.turn).toBe(1);
    expect(keys(rolledBack)).not.toContain("repeat-failure"); // e1 时刻只有一次失败，尚未构成信号
    // 在回退点继续跑，得到的快照与该点连续状态一致
    const continued = fold(rolledBack, bashOk("bun test", 6), { type: "turn-end", at: 7 });
    entries.push({
      id: "e3",
      parentId: "e1",
      type: "custom",
      customType: "alpha-tianshu",
      data: toSnapshot(continued),
    });
    expect(rebuildFromEntries(entries, "e3")).toEqual(continued);
  });
});

describe("天枢证据层 · 投递参数", () => {
  test("空闲投递不开启新一轮（sendMessage 桩断言）", () => {
    const { pi, handlers, sent } = stubPi();
    tianshuEvidenceLayer(pi);
    const { ctx, statuses } = makeCtx({ idle: true, usage: { percent: 12 } });
    fire(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "write",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }, ctx);
    fire(handlers, "turn_end", { type: "turn_end", turnIndex: 1 }, ctx);
    expect(sent).toHaveLength(1);
    const { payload, options } = sent[0]!;
    expect(payload.customType).toBe("alpha-tianshu");
    expect(payload.display).toBe(true);
    expect(options).toEqual({ triggerTurn: false });
    expect("deliverAs" in options).toBe(false);
    expect(String(payload.content)).toContain("由你判断");
    expect(String(payload.content)).toContain("验证");
    // 面向模型的文字不带证据摘要，证据放 details
    const details = payload.details as { timeline: string[] };
    expect(details.timeline.some(line => line.includes("src/foo.ts"))).toBe(true);
    expect(String(payload.content)).not.toContain("src/foo.ts");
    // 状态栏同步更新
    expect(statuses.some(status => status.key === "tianshu" && (status.text ?? "").includes("运行检查"))).toBe(true);
  });

  test("流式进行中用 aside；子代理事件忽略；shadow 只记不发", () => {
    const streaming = stubPi();
    tianshuEvidenceLayer(streaming.pi);
    const busy = makeCtx({ idle: false });
    fire(streaming.handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "write",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }, busy.ctx);
    fire(streaming.handlers, "turn_end", { type: "turn_end", turnIndex: 1 }, busy.ctx);
    expect(streaming.sent).toHaveLength(1);
    expect(streaming.sent[0]!.options).toEqual({ deliverAs: "aside" });

    const sub = stubPi();
    tianshuEvidenceLayer(sub.pi);
    const subCtx = makeCtx({ kind: "sub" });
    fire(sub.handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "write",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }, subCtx.ctx);
    fire(sub.handlers, "turn_end", { type: "turn_end", turnIndex: 1 }, subCtx.ctx);
    expect(sub.sent).toHaveLength(0);
    expect(sub.entries).toHaveLength(0);

    const previous = process.env.ALPHA_CVM_MODE;
    process.env.ALPHA_CVM_MODE = "shadow";
    try {
      const shadow = stubPi();
      tianshuEvidenceLayer(shadow.pi);
      const shadowCtx = makeCtx({ idle: true });
      fire(shadow.handlers, "tool_result", {
        type: "tool_result",
        toolCallId: "c1",
        toolName: "write",
        input: { path: "src/foo.ts" },
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }, shadowCtx.ctx);
      fire(shadow.handlers, "turn_end", { type: "turn_end", turnIndex: 1 }, shadowCtx.ctx);
      expect(shadow.sent).toHaveLength(0);
      expect(shadow.entries.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.ALPHA_CVM_MODE;
      else process.env.ALPHA_CVM_MODE = previous;
    }

    const offPrevious = process.env.ALPHA_CVM_MODE;
    process.env.ALPHA_CVM_MODE = "off";
    try {
      const off = stubPi();
      tianshuEvidenceLayer(off.pi);
      expect(off.handlers.size).toBe(0);
      expect(off.renderers.size).toBe(0);
      expect(off.commands.size).toBe(0);
    } finally {
      if (offPrevious === undefined) delete process.env.ALPHA_CVM_MODE;
      else process.env.ALPHA_CVM_MODE = offPrevious;
    }
  });

  test("/tianshu 展开证据帧且不开新回合", async () => {
    const { pi, handlers, sent, commands, renderers } = stubPi();
    tianshuEvidenceLayer(pi);
    const { ctx } = makeCtx({ idle: true, usage: { percent: 30 } });
    expect(renderers.has("alpha-tianshu")).toBe(true);
    fire(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "write",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }, ctx);
    const handler = commands.get("tianshu");
    expect(handler).toBeDefined();
    await handler?.("", ctx);
    expect(sent).toHaveLength(1);
    const { payload, options } = sent[0]!;
    expect(String(payload.content)).toContain("运行证据帧");
    expect(String(payload.content)).toContain("src/foo.ts");
    expect(options).toEqual({ triggerTurn: false });
  });
});

describe("天枢证据层 · 压缩重锚", () => {
  test("session_compact 后只重锚一次（pending-reanchor 消费一次即清）", () => {
    const { pi, handlers, sent, entries } = stubPi();
    tianshuEvidenceLayer(pi);
    const { ctx } = makeCtx({ idle: true });
    fire(handlers, "goal_updated", { type: "goal_updated", goal: { objective: "交付天枢证据层" } }, ctx);
    fire(handlers, "todo_reminder", {
      type: "todo_reminder",
      todos: [{ content: "补回归测试", status: "pending" }],
      attempt: 1,
      maxAttempts: 2,
    }, ctx);
    fire(handlers, "tool_result", {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "write",
      input: { path: "src/foo.ts" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }, ctx);
    fire(handlers, "session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: false }, ctx);
    const afterCompact = entries.filter(entry => entry.customType === "alpha-tianshu").pop()!;
    expect((afterCompact.data as { pendingReanchor: boolean }).pendingReanchor).toBe(true);
    fire(handlers, "turn_end", { type: "turn_end", turnIndex: 1 }, ctx);
    const reanchors = sent.filter(message => String(message.payload.content).includes("重锚"));
    expect(reanchors).toHaveLength(1);
    const anchorText = String(reanchors[0]!.payload.content);
    expect(anchorText).toContain("当前目标：交付天枢证据层");
    expect(anchorText).toContain("未完待办：补回归测试");
    expect(anchorText).toContain("未解决验证债");
    const afterTurn = entries.filter(entry => entry.customType === "alpha-tianshu").pop()!;
    expect((afterTurn.data as { pendingReanchor: boolean }).pendingReanchor).toBe(false);
    fire(handlers, "turn_end", { type: "turn_end", turnIndex: 2 }, ctx);
    expect(sent.filter(message => String(message.payload.content).includes("重锚"))).toHaveLength(1);
    // 纯归约层面：pending-reanchor 消费一次即清
    const compacted = applyEvent(emptyState(), { type: "compact", at: 1 }).state;
    expect(compacted.pendingReanchor).toBe(true);
    const consumed = applyEvent(compacted, { type: "turn-end", at: 2 });
    expect(consumed.state.pendingReanchor).toBe(false);
    expect(consumed.outbound.filter(item => item.kind === "reanchor")).toHaveLength(1);
    expect(applyEvent(consumed.state, { type: "turn-end", at: 3 }).outbound).toHaveLength(0);
  });
});

describe("天枢证据层 · 重复失败", () => {
  test("repeat-failure 连续 ≥2 次同签名才触发，成功后解除", () => {
    const once = fold(emptyState(), bashFail("bun test", "sig-x"));
    expect(keys(once)).not.toContain("repeat-failure");
    const twice = fold(once, bashFail("bun test", "sig-x", 2));
    expect(keys(twice)).toContain("repeat-failure");
    const different = fold(emptyState(), bashFail("bun test", "sig-x"), bashFail("bun test", "sig-y", 2));
    expect(keys(different)).not.toContain("repeat-failure");
    const cleared = fold(twice, bashOk("bun test", 3));
    expect(keys(cleared)).not.toContain("repeat-failure");
    // 提醒是建议而非闸门；失败签名只进 details 不进正文
    const reminder = renderReminder(buildFrame(twice).signals[0]!, twice);
    expect(reminder.content).toContain("建议先检查原因");
    expect(reminder.content).toContain("由你判断");
    expect(reminder.content).not.toContain("sig-x");
    expect((reminder.details as { failureSignature: string }).failureSignature).toBe("sig-x");
  });
});

describe("天枢证据层 · 状态与面板", () => {
  test("状态栏按信号优先级出文案，上下文占用始终显示", () => {
    const debt = fold(emptyState(), writeOk("src/foo.ts"), { type: "context-usage", at: 2, percent: 80 });
    expect(statusText(debt, buildFrame(debt).signals)).toBe("运行检查 · 改后未验证 · 上下文 80%");
    const clean = fold(emptyState(), { type: "context-usage", at: 1, percent: 42 });
    expect(statusText(clean, buildFrame(clean).signals)).toBe("运行检查 ✓ · 上下文 42%");
    expect(buildFrame(clean).quality.context).toBe("measured");
    const claimed = fold(emptyState(), writeOk("src/foo.ts"), claim("全绿。"));
    expect(statusText(claimed, buildFrame(claimed).signals)).toBe("运行检查 · 宣称待证");
    const failing = fold(emptyState(), bashFail("bun test", "s1"), bashFail("bun test", "s1", 2));
    expect(statusText(failing, buildFrame(failing).signals)).toBe("运行检查 · 重复失败");
  });

  test("证据帧与消息渲染器：竖条样式、测量质量", () => {
    const state = fold(emptyState(), writeOk("src/foo.ts", 1), bashOk("bun test", 2), claim("全绿。", 3));
    const frame = buildFrame(state);
    expect(frame.quality.toolResults).toBe("measured");
    expect(frame.quality.verification).toBe("measured");
    expect(frame.sources.some(source => source.includes("verification"))).toBe(true);
    const lines = renderMessageLines("同类工具错误连续出现。", { timeline: ["2 verification bun test"] }, true);
    expect(lines[0]!.startsWith("▌ ")).toBe(true);
    expect(lines.some(line => line.includes("2 verification bun test"))).toBe(true);
    const collapsed = renderMessageLines("提醒正文", { timeline: ["2 verification bun test"] }, false);
    expect(collapsed).toHaveLength(1);
    const anchor = renderReanchor(state);
    expect(anchor.content).toContain("重锚");
    expect(typeof anchor.details).toBe("object");
  });
});
