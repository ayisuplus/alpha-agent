import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";

const parameters = type({
  understanding: "string",
  findings: type({ text: "string", evidence: "string[]" }).array(),
  openQuestions: "string[]",
  nextActions: "string[]",
});

export function createWorkerCognitionTool(ledger: TaskLedger, attemptId: string): CustomTool<typeof parameters> {
  return {
    name: "alpha_cognition_update", label: "Update this subagent's understanding", loadMode: "essential", parameters,
    description: "Save your current understanding, findings with real receipt IDs, open questions, and next actions. An unsupported finding can have an empty evidence list; it is not verified merely because it is recorded.",
    async execute(_id, args) {
      try {
        const state = await ledger.updateWorkerCognition({ ...args, attemptId });
        return { content: [{ type: "text", text: `Subagent cognition v${state.revision} saved for source ${state.sourceRevision ?? "unknown"}.` }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
