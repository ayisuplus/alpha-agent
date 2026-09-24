import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";
import { runModelWorkOrders } from "./model-workers";

const parameters = type({
  orders: type({ id: "string", objective: "string", ownedPaths: "string[]", resources: "string[]" }).array(),
});

export function createWorkOrderTool(ledger: TaskLedger, dataRoot: string, signal?: AbortSignal, modelSelector?: string): CustomTool<typeof parameters> {
  return {
    name: "alpha_delegate",
    label: "Delegate two independent source changes",
    description: "Run exactly two isolated workers on disjoint owned source paths, then merge only audited changes. The coordinator must re-read merged files, build, and verify the integrated product. Do not delegate browser, preview, or alpha-verification.json.",
    parameters,
    loadMode: "essential",
    async execute(_toolCallId, args, _onUpdate, _ctx, toolSignal) {
      const combined = signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal ?? toolSignal;
      try {
        await ledger.refreshRevision();
        const report = await runModelWorkOrders({
          projectRoot: ledger.state.projectRoot,
          dataRoot,
          taskId: ledger.state.id,
          baseRevision: ledger.state.revision!,
          orders: args.orders,
          signal: combined,
          modelSelector,
        });
        if (report.committed.length) await ledger.refreshRevision();
        return { content: [{ type: "text", text: JSON.stringify(report) }], isError: report.status !== "merged" };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
