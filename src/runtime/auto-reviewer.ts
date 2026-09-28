import { join } from "node:path";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { ompAgentId } from "./omp-settings";
import { ompRegistry } from "./models";
import { isAllowedModelSelector } from "./model-policy";
import type { CommandRequest, IndependentReview } from "./command-approval";

/** Separate, tool-free session: its answer is a proposal, never an execution capability. */
export function independentCommandReviewer(dataRoot: string, modelSelector: string): IndependentReview {
  return async (request: CommandRequest, signal?: AbortSignal) => {
    if (!isAllowedModelSelector(modelSelector)) throw new Error(`Reviewer model is not supported: ${modelSelector}`);
    const { authStorage, modelRegistry } = await ompRegistry();
    try {
      const model = modelRegistry.getAvailable().find(item => `${item.provider}/${item.id}` === modelSelector);
      if (!model) throw new Error(`Reviewer model unavailable: ${modelSelector}`);
      const { session } = await createAgentSession({
      cwd: dataRoot, agentDir: join(dataRoot, "omp"), authStorage, modelRegistry, model, agentId: ompAgentId("command-review"),
      sessionManager: SessionManager.inMemory(dataRoot),
      systemPrompt: "You are Alpha's independent command approval reviewer. You have no tools. Review only the exact requested command. Approve only when the action is clearly bounded, reversible and needed for the stated check. If destructive, credential-related, privilege-changing, persistent, external-publishing or uncertain, return user. If unsafe, return deny. Respond with one JSON object only: {\"decision\":\"approve|deny|user\",\"reason\":\"brief reason\"}.",
      toolNames: [], restrictToolNames: true, disableExtensionDiscovery: true,
      enableMCP: false, enableLsp: false, skipPythonPreflight: true,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      });
      const abort = () => void session.abort();
      const timer = setTimeout(abort, 40_000);
      signal?.addEventListener("abort", abort, { once: true });
      try {
      signal?.throwIfAborted();
      await session.prompt(JSON.stringify({ action: "command", argv: request.argv, scriptCommand: request.scriptCommand, cwd: request.cwd, purpose: request.purpose, reason: request.reason, risk: request.risk }));
      const last = session.getLastAssistantMessage();
      if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.errorMessage ?? "Reviewer did not complete");
      const text = last.content.filter(item => item.type === "text").map(item => item.text).join("").trim();
      const decision = JSON.parse(text) as { decision?: unknown; reason?: unknown };
      if (!["approve", "deny", "user"].includes(decision.decision as string) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 500) throw new Error("Reviewer returned an invalid decision");
      return { decision: decision.decision as "approve" | "deny" | "user", reason: decision.reason.trim() };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        await session.dispose();
      }
    } finally { authStorage.close(); }
  };
}
