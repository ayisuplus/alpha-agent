import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";

const parameters = type({ capability: "'network' | 'mcp' | 'browser' | 'media' | 'command' | 'document' | 'source' | 'delegate' | 'expert' | 'permission' | 'plan'", reason: "string", details: "string" });

/** Suspends an isolated instance when a capability needs main-side execution. */
export function createWorkerCapabilityTool(ledger: TaskLedger): CustomTool<typeof parameters> {
  return {
    name: "alpha_capability_request", label: "Request coordinator capability", loadMode: "essential", parameters,
    description: "When the work order needs network/source access, MCP, media, document generation, a command, another expert, delegation, a permission change, or a browser that is not connected, record the exact request for the coordinator. This tool does not grant access or execute the action. End with needs-context; the coordinator may perform the controlled step and issue a new work order.",
    async execute(_id, args) {
      try {
        if (!args.reason.trim() || !args.details.trim() || args.reason.length > 1000 || args.details.length > 4000) throw new Error("能力请求需要简明原因和具体操作");
        const requests = [...(ledger.state.workerOutcome?.requests ?? []), { capability: args.capability, reason: args.reason.trim(), details: args.details.trim() }];
        await ledger.recordWorkerOutcome({ status: "needs-context", findings: [`需要主代理处理 ${args.capability}: ${args.reason.trim()}`], requests });
        return { content: [{ type: "text", text: "请求已记录。请以 needs-context 结束工单；主代理处理后会重新派发。" }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
