import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { advanceTurn, assembleCognitiveFrame, classifyVerificationCommand, emptyCognitiveState, evidenceDigest, observeTool, renderCognitiveMirror, type CognitiveState } from "./tianshu-cognition";

/** Advisory-only native extension: no tool interception, second loop, or automatic turn. */
export default function tianshuCognition(pi: ExtensionAPI): void {
  const file = process.env.ALPHA_COGNITION_FILE;
  const mode = process.env.ALPHA_CVM_MODE === "off" ? "off" : process.env.ALPHA_CVM_MODE === "shadow" ? "shadow" : "active";
  if (!file || mode === "off") return;
  const snapshotFile = file;
  let state: CognitiveState = emptyCognitiveState();
  let activeSession = "";
  let saveQueue = Promise.resolve();
  const calls = new Map<string, string>();

  function persist(): void {
    const snapshot = { sessionId: activeSession, mode, state, frame: assembleCognitiveFrame(state) };
    saveQueue = saveQueue.then(async () => {
      await mkdir(dirname(snapshotFile), { recursive: true });
      const temp = `${snapshotFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot));
      await rename(temp, snapshotFile);
    }).catch(error => pi.logger.warn(`Alpha cognition snapshot unavailable: ${String(error)}`));
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    activeSession = ctx.sessionManager.getSessionId();
    const saved = await readFile(snapshotFile, "utf8").then(text => JSON.parse(text), () => null).catch(() => null);
    if (saved?.sessionId === activeSession && saved.state?.turn >= 0) state = saved.state as CognitiveState;
    persist();
  });

  pi.on("session_switch", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    activeSession = ctx.sessionManager.getSessionId();
    state = emptyCognitiveState();
    calls.clear();
    persist();
  });

  pi.on("message_end", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const message = event.message;
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, typeof part.arguments.command === "string" ? part.arguments.command : "");
    } else if (message.role === "toolResult") {
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      state = observeTool(state, { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError,
        textDigest: evidenceDigest(text), verificationCommand: classifyVerificationCommand(calls.get(message.toolCallId) ?? "") });
      calls.delete(message.toolCallId);
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const usage = ctx.getContextUsage();
    state = advanceTurn(state, usage && { tokens: usage.tokens, contextWindow: usage.contextWindow });
    persist();
  });

  pi.on("context", (event, ctx) => {
    if (ctx.agent.kind !== "main" || mode !== "active") return;
    const note = renderCognitiveMirror(assembleCognitiveFrame(state));
    if (!note) return;
    return { messages: [...event.messages, { role: "custom", customType: "alpha-cvm", content: note, display: false, timestamp: 0 }] };
  });
}
