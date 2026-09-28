import type { AutomationInput } from "../../runtime/automations";
import { isModelAvailable } from "../../runtime/models";
import { ID, body, failure, path, type Route } from "../http";
import { drainAutomations, drainQueue } from "../runs";

export const automationRoutes: Route[] = [
  { method: "GET", path: "/api/automations", async handle({ ctx }) { return Response.json(await ctx.automationStore.list()); } },
  {
    method: "POST", path: "/api/automations",
    async handle({ ctx, request }) {
      try {
        const input = await request.json() as AutomationInput;
        if (input.kind === "heartbeat" && !await ctx.loadLedger(input.targetTaskId ?? "")) throw new Error("Automation target task is unavailable");
        if (input.kind === "cron" && input.projectId) {
          const project = await ctx.projectStore.get(input.projectId);
          if (!project || project.mounts.length && !project.mounts.some(item => item.id === input.mountId)) throw new Error("Automation project or working directory is unavailable");
        }
        if (input.modelSelector && !await isModelAvailable(input.modelSelector)) throw new Error("Automation model is unavailable");
        return Response.json({ automation: await ctx.automationStore.create(input) });
      } catch (error) { return failure(error); }
    },
  },
  {
    method: "PATCH", path: path(`/api/automations/${ID}`),
    async handle({ ctx, request, params: [id] }) {
      try {
        const patch = await request.json() as Partial<AutomationInput> & { status?: "ACTIVE" | "PAUSED" };
        if (patch.targetTaskId && !await ctx.loadLedger(patch.targetTaskId)) throw new Error("Automation target task is unavailable");
        if (patch.modelSelector && !await isModelAvailable(patch.modelSelector)) throw new Error("Automation model is unavailable");
        return Response.json({ automation: await ctx.automationStore.update(id, patch) });
      } catch (error) { return failure(error); }
    },
  },
  {
    method: "DELETE", path: path(`/api/automations/${ID}`),
    async handle({ ctx, params: [id] }) {
      try { await ctx.automationStore.delete(id); return Response.json({ deleted: true }); }
      catch (error) { return failure(error); }
    },
  },
  {
    method: "POST", path: path(`/api/automations/${ID}/run`),
    async handle({ ctx, params: [id] }) {
      try { const run = await ctx.automationStore.runNow(id); void drainAutomations(ctx); return Response.json({ run }); }
      catch (error) { return failure(error); }
    },
  },
  {
    method: "POST", path: path(`/api/automation-runs/${ID}/read`),
    async handle({ ctx, params: [id] }) {
      try { await ctx.automationStore.markRead(id); return Response.json({ read: true }); }
      catch (error) { return failure(error); }
    },
  },
  { method: "GET", path: "/api/queue", async handle({ ctx }) { return Response.json(await ctx.taskQueue.all()); } },
  {
    method: "POST", path: "/api/queue",
    async handle({ ctx, request }) {
      const input = await body<{ taskId?: unknown; instruction?: unknown }>(request, {});
      if (typeof input.taskId !== "string" || !await ctx.loadLedger(input.taskId) || typeof input.instruction !== "string") return Response.json({ error: "Queue task or instruction is invalid" }, { status: 400 });
      const item = await ctx.taskQueue.enqueue(input.taskId, input.instruction);
      void drainQueue(ctx);
      return Response.json({ item });
    },
  },
  {
    method: "DELETE", path: path(`/api/queue/${ID}`),
    async handle({ ctx, params: [id] }) { await ctx.taskQueue.cancel(id); return Response.json({ cancelled: true }); },
  },
  { method: "GET", path: "/api/schedules", async handle({ ctx }) { return Response.json(await ctx.taskQueue.all()); } },
  {
    method: "POST", path: "/api/schedules",
    async handle({ ctx, request }) {
      const input = await body<{ taskId?: unknown; instruction?: unknown; nextRunAt?: unknown; intervalMinutes?: unknown }>(request, {});
      if (typeof input.taskId !== "string" || !await ctx.loadLedger(input.taskId) || typeof input.instruction !== "string" || typeof input.nextRunAt !== "string" || input.intervalMinutes !== null && typeof input.intervalMinutes !== "number") return Response.json({ error: "Schedule fields are invalid" }, { status: 400 });
      const schedule = await ctx.taskQueue.schedule(input.taskId, input.instruction, input.nextRunAt, input.intervalMinutes as number | null);
      return Response.json({ schedule });
    },
  },
  {
    method: "DELETE", path: path(`/api/schedules/${ID}`),
    async handle({ ctx, params: [id] }) { await ctx.taskQueue.disable(id); return Response.json({ disabled: true }); },
  },
];
