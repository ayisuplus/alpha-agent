import { randomUUID } from "node:crypto";
import { type } from "@oh-my-pi/omptype";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "./task-ledger";
import type { AgentPresetSnapshot } from "./agent-presets";
import { AgentPresetStore } from "./agent-presets";
import { SkillPluginStore } from "../plugins/third-party";
import { validateSkillBindings } from "./skill-binding";
import { resolveWorkOrders } from "./work-order-tool";
import type { WorkOrder } from "./work-orders";
import type { WorkerSupervisor } from "./worker-supervisor";
import { createCoordinatorMailboxTools } from "./agent-mailbox";

const orderParameters = type({ orders: type({ id: "string", objective: "string", ownedPaths: "string[]", resources: "string[]", readPaths: "string[]?", mode: "string?", expertId: "string?", skillIds: "string[]?", dependsOn: "string[]?", acceptance: "string[]?" }).array(), "concurrency?": "number" });
const idParameters = type({ id: "string" });
const continueParameters = type({ agentId: "string", instruction: "string", mode: "string?" });
const waitParameters = type({ ids: "string[]", "timeoutMs?": "number" });
const success = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });

export function createAsyncWorkTools(getSupervisor: () => WorkerSupervisor, ledger: TaskLedger, dataRoot: string, _presets: readonly AgentPresetSnapshot[], _skills: readonly Skill[]) {
  return [
    ...createCoordinatorMailboxTools(getSupervisor().mailbox),
    {
      name: "alpha_spawn", label: "Start isolated workers", loadMode: "essential" as const,
      description: "Start expert subagents in independent Git worktrees. Each needs a versioned persona and at least one Skill. Investigation and review cannot edit source. Return stable agent IDs and run IDs; inspect results before integration.",
      parameters: orderParameters,
      async execute(_id: string, args: typeof orderParameters.infer) {
        try {
          const [presets, skills] = await Promise.all([new AgentPresetStore(dataRoot).enabled(), new SkillPluginStore(dataRoot).loadSkills()]);
          const requested = (args.orders as WorkOrder[]).map(order => {
            const planned = ledger.state.cognition?.steps.find(step => step.id === order.id);
            if (ledger.state.planApproval && !planned) throw new Error(`Approved plan has no order: ${order.id}`);
            if (planned && (order.objective !== planned.objective || (order.mode && order.mode !== planned.mode) || (order.dependsOn && JSON.stringify(order.dependsOn) !== JSON.stringify(planned.dependsOn)) || (order.expertId && order.expertId !== planned.expertId))) throw new Error(`Order conflicts with approved plan: ${order.id}`);
            if (planned && ["running", "complete", "cancelled"].includes(planned.status)) throw new Error(`Plan step is already dispatched: ${order.id}`);
            return { ...order, mode: planned?.mode ?? order.mode, dependsOn: planned?.dependsOn ?? order.dependsOn, expertId: planned?.expertId ?? order.expertId, skillIds: [...new Set([...(planned?.skillIds ?? []), ...(order.skillIds ?? [])])] };
          });
          const orders = resolveWorkOrders(requested, presets, skills).map(order => {
            if (!order.preset?.package || !order.skillIds?.length) throw new Error(`Subagent ${order.id} requires a versioned expert persona and at least one Skill`);
            return { ...order, readPaths: requested.find(item => item.id === order.id)?.readPaths, fullAccess: true, agentId: randomUUID(), instanceId: randomUUID(), contractVersion: ledger.state.contractVersion ?? 1, cognitionRevision: ledger.state.cognition?.revision ?? 1, baseRevision: ledger.state.revision ?? undefined };
          });
          const expertStore = new AgentPresetStore(dataRoot);
          for (const order of orders) await validateSkillBindings([order], [...(order.preset ? await expertStore.loadBundledSkills(order.preset) : []), ...skills]);
          return success({ ids: await getSupervisor().spawn(orders, args.concurrency), agents: orders.map(order => ({ agentId: order.agentId, runId: order.instanceId, expertId: order.expertId })) });
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "alpha_continue", label: "Continue the same subagent", loadMode: "essential" as const,
      description: "Send a follow-up to a stable subagent. The same expert, Skill snapshots, cognition, session and worktree continue in a new run. A mode switch takes effect only for the new run.",
      parameters: continueParameters,
      async execute(_id: string, args: typeof continueParameters.infer) {
        try { return success({ agentId: args.agentId, runId: await getSupervisor().continue(args.agentId, args.instruction, args.mode as "investigate" | "implement" | "review" | undefined) }); }
        catch (error) { return failure(error); }
      },
    },
    {
      name: "alpha_inspect", label: "Inspect worker", loadMode: "essential" as const,
      description: "Read the exact isolated worker result and bounded source diff before deciding whether to integrate it.", parameters: idParameters,
      async execute(_id: string, args: typeof idParameters.infer) { try { return success(await getSupervisor().inspect(args.id)); } catch (error) { return failure(error); } },
    },
    {
      name: "alpha_wait", label: "Wait for workers", loadMode: "essential" as const,
      description: "Wait for a worker result without treating a timeout as a failure. Returns current states and reviewable output.", parameters: waitParameters,
      async execute(_id: string, args: typeof waitParameters.infer) { try { return success(await getSupervisor().wait(args.ids, args.timeoutMs ?? 30_000)); } catch (error) { return failure(error); } },
    },
    {
      name: "alpha_cancel", label: "Cancel worker", loadMode: "essential" as const,
      description: "Cancel only one queued or running worker attempt; keep other attempts and their results.", parameters: idParameters,
      async execute(_id: string, args: typeof idParameters.infer) { try { await getSupervisor().cancel(args.id); return success({ id: args.id, cancelled: true }); } catch (error) { return failure(error); } },
    },
    {
      name: "alpha_integrate", label: "Integrate reviewed worker", loadMode: "essential" as const,
      description: "After inspecting an attempt, merge its actual source changes with version and read-dependency checks. A conflict keeps its worktree for review.", parameters: idParameters,
      async execute(_id: string, args: typeof idParameters.infer) { try { return success(await getSupervisor().integrate(args.id)); } catch (error) { return failure(error); } },
    },
  ];
}
