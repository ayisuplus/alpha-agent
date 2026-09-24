import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";
import { runModelWorkOrders } from "./model-workers";
import type { AgentPresetSnapshot } from "./agent-presets";
import type { WorkOrder } from "./work-orders";

const parameters = type({
  orders: type({ id: "string", objective: "string", ownedPaths: "string[]", resources: "string[]", presetId: "string?" }).array(),
});

export function resolveWorkOrders(orders: WorkOrder[], presets: readonly AgentPresetSnapshot[]): WorkOrder[] {
  return orders.map(order => {
    const presetId = order.presetId ?? "general";
    const preset = presets.find(item => item.id === presetId);
    if (!preset) throw new Error(`角色预设不存在或未启用：${presetId}`);
    return { ...order, presetId, preset };
  });
}

export function createWorkOrderTool(ledger: TaskLedger, dataRoot: string, signal?: AbortSignal, modelSelector?: string, presets: readonly AgentPresetSnapshot[] = [], onStatus?: (value: string) => void): CustomTool<typeof parameters> {
  return {
    name: "alpha_delegate",
    label: "Delegate two independent source changes",
    description: "Run exactly two isolated workers on disjoint owned source paths, then merge only audited changes. The coordinator must re-read merged files, build, and verify the integrated product. Do not delegate browser, preview, or alpha-verification.json.",
    parameters,
    loadMode: "essential",
    async execute(_toolCallId, args, _onUpdate, _ctx, toolSignal) {
      const combined = signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal ?? toolSignal;
      try {
        const orders = resolveWorkOrders(args.orders, presets);
        await ledger.refreshRevision();
        const report = await runModelWorkOrders({
          projectRoot: ledger.state.projectRoot,
          dataRoot,
          taskId: ledger.state.id,
          baseRevision: ledger.state.revision!,
          orders,
          signal: combined,
          modelSelector,
          onWorkerEvent(order, state) {
            onStatus?.(`子代理 ${order.id} · ${order.preset!.name} · ${state === "started" ? `开始（${order.preset!.hash.slice(0, 8)}）` : state === "completed" ? "完成源码工单" : "执行失败"}`);
          },
        });
        if (report.committed.length) await ledger.refreshRevision();
        onStatus?.(`子代理合并${report.status === "merged" ? "成功" : "未完成"}：${orders.map(order => `${order.id}=${order.preset!.name}`).join("、")}`);
        return { content: [{ type: "text", text: JSON.stringify(report) }], isError: report.status !== "merged" };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
