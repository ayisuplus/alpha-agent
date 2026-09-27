import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";
import { runModelWorkOrders } from "./model-workers";
import type { AgentPresetSnapshot } from "./agent-presets";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { AgentPresetStore } from "./agent-presets";
import { SkillPluginStore } from "../plugins/third-party";
import { validateSkillBindings } from "./skill-binding";
import type { WorkOrder } from "./work-orders";
import type { BrowserSession } from "./visible-browser";

const parameters = type({
  orders: type({ id: "string", objective: "string", ownedPaths: "string[]", resources: "string[]", readPaths: "string[]?", mode: "string?", expertId: "string?", skillIds: "string[]?", modelSelector: "string?", dependsOn: "string[]?", acceptance: "string[]?" }).array(),
});

export function resolveWorkOrders(orders: WorkOrder[], presets: readonly AgentPresetSnapshot[], skills: readonly Skill[] = []): WorkOrder[] {
  return orders.map(order => {
    const expertId = order.expertId ?? order.presetId;
    const preset = expertId ? presets.find(item => item.id === expertId) : undefined;
    if (expertId && !preset) throw new Error(`专家不存在或未启用：${expertId}`);
    const skillIds = [...new Set([...(preset?.skillIds ?? []), ...(order.skillIds ?? [])])];
    const missing = skillIds.find(id => !skills.some(skill => skill.name === id) && !preset?.package?.skills.some(skill => skill.id === id));
    if (missing) throw new Error(`Skill 未安装或未启用：${missing}`);
    if (order.mode && !["investigate", "implement", "review"].includes(order.mode)) throw new Error(`执行模式无效：${order.mode}`);
    return { ...order, expertId, presetId: expertId, preset, mode: order.mode ?? "implement", readPaths: order.mode === "review" ? [...new Set([".", ...(order.readPaths ?? [])])] : order.readPaths, skillIds };
  });
}

export function createWorkOrderTool(ledger: TaskLedger, dataRoot: string, signal?: AbortSignal, modelSelector?: string, presets: readonly AgentPresetSnapshot[] = [], skills: readonly Skill[] = [], onStatus?: (value: string) => void, browser?: { browser?: BrowserSession; browserUrl?: string; browserAccess?: () => boolean }): CustomTool<typeof parameters> {
  return {
    name: "alpha_delegate",
    label: "Delegate scoped work",
    description: "Run one or two independent work orders in isolated instances. Set modelSelector per order for a different worker model; omit it to inherit the main agent model. The cognitive plan can propose experts, but only selected orders are started. Use expertId only for an enabled expert; omit for a neutral instance. Set readPaths to the specific source files or directories this worker may inspect; ownedPaths are also readable. Read-only investigate/review orders must have no ownedPaths. Implementation ownership must be disjoint. Parent verifies integration and final acceptance.",
    parameters,
    loadMode: "essential",
    async execute(_toolCallId, args, _onUpdate, _ctx, toolSignal) {
      const combined = signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal ?? toolSignal;
      try {
        const [currentExperts, currentSkills] = await Promise.all([new AgentPresetStore(dataRoot).enabled(), new SkillPluginStore(dataRoot).loadSkills()]);
        const requested = (args.orders as WorkOrder[]).map(order => {
          const planned = ledger.state.cognition?.steps.find(step => step.id === order.id);
          if (ledger.state.planApproval && !planned) throw new Error(`已批准的计划没有工单步骤：${order.id}`);
          if (planned && (order.expertId ?? order.presetId) && (order.expertId ?? order.presetId) !== planned.expertId) throw new Error(`工单专家与已记录计划冲突：${order.id}`);
          if (planned && (order.objective !== planned.objective || (order.mode && order.mode !== planned.mode) || (order.dependsOn && JSON.stringify(order.dependsOn) !== JSON.stringify(planned.dependsOn)))) throw new Error(`工单与已记录计划冲突：${order.id}`);
          if (planned && (planned.status === "running" || planned.status === "complete" || planned.status === "cancelled")) throw new Error(`计划步骤不可重复派发：${order.id}`);
          return { ...order, mode: planned?.mode ?? order.mode, dependsOn: planned?.dependsOn ?? order.dependsOn, expertId: planned ? planned.expertId : order.expertId, presetId: planned ? planned.expertId : order.presetId, skillIds: [...new Set([...(planned?.skillIds ?? []), ...(order.skillIds ?? [])])] };
        });
        if (ledger.state.designatedExpertId && !ledger.state.cognition?.steps.length && requested.some(order => (order.mode ?? "implement") === "implement") && !requested.some(order => order.expertId === ledger.state.designatedExpertId)) throw new Error(`用户指定专家尚未分配到工单：${ledger.state.designatedExpertId}`);
        const orders = resolveWorkOrders(requested, currentExperts, currentSkills).map(order => ({ ...order, instanceId: randomUUID(), contractVersion: ledger.state.contractVersion ?? 1, cognitionRevision: ledger.state.cognition?.revision ?? 1, baseRevision: ledger.state.revision ?? undefined }));
        const expertStore = new AgentPresetStore(dataRoot);
        for (const order of orders) {
          const bundled = order.preset ? await expertStore.loadBundledSkills(order.preset) : [];
          await validateSkillBindings([order], [...bundled, ...currentSkills]);
        }
        for (const order of orders) for (const dependency of order.dependsOn ?? []) {
          if (orders.some(item => item.id === dependency) || ledger.state.cognition?.steps.find(step => step.id === dependency)?.status !== "complete") throw new Error(`工单依赖尚未完成：${order.id} -> ${dependency}`);
        }
        await ledger.refreshRevision();
        const report = await runModelWorkOrders({
          projectRoot: ledger.state.projectRoot,
          dataRoot,
          taskId: ledger.state.id,
          baseRevision: ledger.state.revision!,
          orders,
          signal: combined,
          modelSelector,
          browser: browser?.browser,
          browserUrl: browser?.browserUrl,
          browserAccess: browser?.browserAccess,
          async onWorkerUsage(_order, usage) {
            await ledger.recordRun({ model: usage.model, stage: "worker", instanceId: _order.instanceId, toolCalls: usage.toolCalls, maxToolCalls: 40, wallTimeMs: 0, elapsedMs: 0, childElapsedMs: usage.elapsedMs, usageIncomplete: usage.incomplete, usage: usage.tokens, outcome: usage.outcome ?? "returned" });
          },
          async onWorkerEvent(order, state) {
            if (state === "started") await ledger.recordDispatch({ id: order.instanceId!, orderId: order.id, mode: order.mode ?? "implement", expert: order.preset ? { id: order.preset.id, name: order.preset.name, hash: order.preset.hash } : undefined, skills: order.skillSnapshots ?? [] });
            onStatus?.(`子代理 ${order.id} · ${order.preset?.name ?? "通用执行"} · ${state === "started" ? "开始" : state === "completed" ? "已返回" : "执行失败"}`);
          },
        });
        for (const order of orders) await ledger.finishDispatch(order.instanceId!, report.status === "merged" ? "completed" : report.results[order.id]?.status === "needs-context" ? "blocked" : "failed", report.results[order.id]?.findings ?? (report.reason ? [report.reason] : []));
        if (report.committed.length) await ledger.refreshRevision();
        onStatus?.(`子代理工单${report.status === "merged" ? "完成" : "未完成"}：${orders.map(order => `${order.id}=${order.preset?.name ?? "通用执行"}`).join("、")}`);
        return { content: [{ type: "text", text: JSON.stringify(report) }], isError: report.status !== "merged" };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
