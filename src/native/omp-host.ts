/** Keep OMP's CLI bootstrap intact; only bind Alpha controls to its SDK result. */
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { NativeHostControl } from "./host-control";
import type { HostRequest } from "./host-types";

const args = process.argv.slice(2);
await runRootCommand(parseArgs(args), args, {
  createAgentSession: async options => {
    const result = await createAgentSession(options);
    const control = new NativeHostControl(result, frame => process.send?.({ ...frame, type: "alpha_event", event: frame }), options?.subagentEventBus);
    await control.plan.restore();
    let writes = Promise.resolve();
    process.on("message", (message: unknown) => {
      const request = message as HostRequest;
      if (request?.type !== "alpha_request" || typeof request.id !== "string") return;
      const execute = async () => {
        try { process.send?.({ type: "alpha_response", id: request.id, success: true, data: await control.request(request.method, request.input) }); }
        catch (error) { process.send?.({ type: "alpha_response", id: request.id, success: false, error: error instanceof Error ? error.message : String(error) }); }
      };
      if (["catalog", "mode", "tree", "usage"].includes(request.method) || request.method === "plan" && request.input?.action === "cancel-compaction") void execute();
      else { writes = writes.then(execute); }
    });
    return result;
  },
});
