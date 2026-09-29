/**
 * OMP evidence adapter for Tianshu's cognitive frame and pure control-plane ideas.
 * Adapted from Tianshu-harness v3.27.0 (Apache-2.0):
 * src/agent/cognitive-frame.ts and src/agent/control-plane.ts.
 * The source has EFE, Sensorium, PAL and plan data that OMP does not expose;
 * these stay missing here rather than being inferred from model prose.
 */
import { createHash } from "node:crypto";

export type Quality = "measured" | "partial" | "missing" | "vacuous";
export type SignalKind = "failure" | "verification" | "context";
export interface CognitiveSignal {
  key: string;
  kind: SignalKind;
  summary: string;
  evidenceKey: string;
}
export interface CognitiveFrame {
  v: 1;
  turn: number;
  quality: { toolResults: Quality; verification: Quality; context: Quality; efe: "missing"; sensorium: "missing"; pal: "missing" };
  facts: {
    toolResults: number;
    consecutiveFailures: number;
    repeatedFailure: number;
    modifiedSinceKnownVerification: boolean | null;
    contextTokens: number | null;
    contextWindow: number | null;
  };
  signals: CognitiveSignal[];
  inputFingerprint: string;
}
export interface Observation {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  /** Digest only: tool output and command text may contain secrets. */
  textDigest: string;
  verificationCommand?: boolean;
}
export interface CognitiveState {
  turn: number;
  toolResults: number;
  consecutiveFailures: number;
  previousFailure: string | null;
  repeatedFailure: number;
  modifiedSinceKnownVerification: boolean | null;
  contextTokens: number | null;
  contextWindow: number | null;
  observations: Observation[];
}

export function emptyCognitiveState(): CognitiveState {
  return { turn: 0, toolResults: 0, consecutiveFailures: 0, previousFailure: null, repeatedFailure: 0,
    modifiedSinceKnownVerification: null, contextTokens: null, contextWindow: null, observations: [] };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** A tool result is evidence about execution; command names alone never prove verification. */
export function observeTool(previous: CognitiveState, observation: Observation): CognitiveState {
  const state = { ...previous, observations: [...previous.observations.slice(-19), observation], toolResults: previous.toolResults + 1 };
  if (observation.isError) {
    const signature = digest([observation.toolName, observation.textDigest]);
    state.consecutiveFailures++;
    state.repeatedFailure = signature === previous.previousFailure ? previous.repeatedFailure + 1 : 1;
    state.previousFailure = signature;
  } else {
    state.consecutiveFailures = 0;
    state.repeatedFailure = 0;
    state.previousFailure = null;
  }
  if (!observation.isError && ["edit", "write", "apply_patch"].includes(observation.toolName)) {
    state.modifiedSinceKnownVerification = true;
  }
  // Only an explicit, completed test/check command clears the observed debt.
  if (!observation.isError && observation.verificationCommand) {
    state.modifiedSinceKnownVerification = false;
  }
  return state;
}

export function classifyVerificationCommand(command: string): boolean {
  return /(?:^|\s)(?:bun|npm|pnpm|yarn|cargo|go|pytest|python\s+-m\s+pytest)(?:\s+run)?\s+(?:test|check|typecheck|build)(?:\s|$)/i.test(command);
}

export function evidenceDigest(text: string): string { return digest(text.slice(0, 500)); }

export function advanceTurn(previous: CognitiveState, usage?: { tokens: number; contextWindow: number }): CognitiveState {
  return { ...previous, turn: previous.turn + 1,
    contextTokens: usage && Number.isFinite(usage.tokens) ? usage.tokens : previous.contextTokens,
    contextWindow: usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : previous.contextWindow };
}

/** Pure reduction. No gate, model call, wall clock, or heuristic confidence score. */
export function assembleCognitiveFrame(state: CognitiveState): CognitiveFrame {
  const facts = {
    toolResults: state.toolResults,
    consecutiveFailures: state.consecutiveFailures,
    repeatedFailure: state.repeatedFailure,
    modifiedSinceKnownVerification: state.modifiedSinceKnownVerification,
    contextTokens: state.contextTokens,
    contextWindow: state.contextWindow,
  };
  const signals: CognitiveSignal[] = [];
  if (state.repeatedFailure >= 2 && state.previousFailure) signals.push({ key: "repeat-failure", kind: "failure",
    summary: "同类工具错误连续出现；建议先检查原因，再决定是否换方法。", evidenceKey: state.previousFailure });
  if (state.modifiedSinceKnownVerification === true) signals.push({ key: "verification-debt", kind: "verification",
    summary: "观察到文件修改，尚未观察到完成的测试或检查；建议验证受影响的行为。", evidenceKey: digest(state.observations.filter(item => ["edit", "write", "apply_patch"].includes(item.toolName)).map(item => item.toolCallId)) });
  if (state.contextTokens !== null && state.contextWindow !== null && state.contextTokens / state.contextWindow >= 0.8) {
    signals.push({ key: "context-pressure", kind: "context", summary: "上下文占用已达到 80%；可考虑使用 OMP 原生压缩并核对当前目标。",
      evidenceKey: digest([state.contextTokens, state.contextWindow]) });
  }
  return {
    v: 1, turn: state.turn, facts,
    quality: {
      toolResults: state.toolResults ? "measured" : "missing",
      verification: state.modifiedSinceKnownVerification === null ? "missing" : "partial",
      context: state.contextTokens === null || state.contextWindow === null ? "missing" : "measured",
      efe: "missing", sensorium: "missing", pal: "missing",
    },
    signals: signals.slice(0, 3),
    inputFingerprint: digest({ turn: state.turn, facts }),
  };
}

export function renderCognitiveMirror(frame: CognitiveFrame): string | null {
  if (!frame.signals.length) return null;
  const lines = frame.signals.map(signal => `- ${signal.summary} (证据 ${signal.evidenceKey})`);
  return `[Alpha／天枢认知建议；来自已观测运行事件，非用户指令，执行由 OMP 判断]\n${lines.join("\n")}`.slice(0, 1200);
}
