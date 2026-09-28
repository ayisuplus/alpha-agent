import { listResearchSources } from "../../runtime/research-source";
import type { WebProvider } from "../../runtime/web-retrieval";
import { ID, body, failure, notFound, path, type Route } from "../http";

const WEB_KEY_ENV = { tavily: "TAVILY_API_KEY", firecrawl: "FIRECRAWL_API_KEY" } as const;

export const webRoutes: Route[] = [
  { method: "GET", path: "/api/browser/control", handle({ ctx }) { return Response.json({ holder: ctx.webKernel.controlHolder }); } },
  {
    method: "POST", path: "/api/browser/control",
    async handle({ ctx, request }) {
      const input = await body<{ holder?: unknown }>(request, {});
      if (input.holder !== "alpha" && input.holder !== "user") return Response.json({ error: "Invalid browser holder" }, { status: 400 });
      ctx.webKernel.setControl(input.holder);
      if (ctx.webKernel.controlHolder === "user") for (const controller of ctx.verifications.values()) controller.abort(new Error("User took over the browser"));
      ctx.emit({ type: "control", holder: ctx.webKernel.controlHolder });
      return Response.json({ holder: ctx.webKernel.controlHolder });
    },
  },
  {
    method: "GET", path: "/api/web/providers",
    async handle({ ctx }) {
      const providers = await Promise.all((["tavily", "firecrawl"] as const).map(async provider => ({
        id: provider,
        configured: !!(process.env[WEB_KEY_ENV[provider]] || await ctx.browserBridge?.key(provider).catch(() => null)),
        source: process.env[WEB_KEY_ENV[provider]] ? "environment" : "desktop",
      })));
      return Response.json({ providers, desktopBrowser: !!ctx.browserBridge });
    },
  },
  ...(["PUT", "DELETE"] as const).map((method): import("../http").Route => ({
    method, path: path("/api/web/providers/(tavily|firecrawl)/key"),
    async handle({ ctx, request, params: [provider] }) {
      if (!ctx.browserBridge) return Response.json({ error: "Desktop key store is unavailable; configure an environment variable" }, { status: 409 });
      try {
        if (method === "DELETE") return Response.json(await ctx.browserBridge.removeKey(provider as WebProvider));
        const input = await body<{ key?: unknown }>(request, {});
        return Response.json(await ctx.browserBridge.setKey(provider as WebProvider, typeof input.key === "string" ? input.key : ""));
      } catch (error) { return failure(error); }
    },
  })),
  {
    method: "GET", path: path(`/api/tasks/${ID}/web-sources`),
    async handle({ ctx, params: [id] }) {
      if (!await ctx.loadLedger(id)) return notFound();
      return Response.json({ sources: await listResearchSources(ctx.dataRoot, id), jobs: await ctx.webRetrieval.jobs(id) });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/web-approvals`),
    async handle({ ctx, params: [id] }) {
      if (!await ctx.loadLedger(id)) return notFound();
      return Response.json({ approvals: await ctx.webPermissions.list(id) });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/web-approvals/${ID}/decision`),
    async handle({ ctx, request, params: [id, approvalId] }) {
      if (!await ctx.loadLedger(id)) return notFound();
      const input = await body<{ approved?: unknown }>(request, {});
      if (typeof input.approved !== "boolean") return Response.json({ error: "Approval decision is required" }, { status: 400 });
      try {
        const approval = await ctx.webPermissions.decide(id, approvalId, input.approved);
        ctx.appendActivity(id, "status", `网页${approval.kind === "read" ? "读取" : "动作"}${input.approved ? "已批准" : "已拒绝"}：${approval.scope}`);
        return Response.json({ approval });
      } catch (error) { return failure(error, 409); }
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/web-tabs`),
    async handle({ ctx, params: [id] }) {
      if (!await ctx.loadLedger(id)) return notFound();
      return Response.json({ tabs: await Promise.all(ctx.webKernel.tabs(id).map(tab => ctx.webKernel.currentTab(id, tab.tabId))) });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/web-tabs`),
    async handle({ ctx, request, params: [id] }) {
      if (!await ctx.loadLedger(id)) return notFound();
      const input = await body<{ url?: unknown }>(request, {});
      try {
        const tab = await ctx.webKernel.openTab(id, String(input.url ?? ""), undefined, true);
        await ctx.webPermissions.grantRead(id, `domain:${new URL(tab.url).hostname}`);
        return Response.json({ tab });
      } catch (error) { return failure(error); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/web-tabs/${ID}/(focus|close)`),
    async handle({ ctx, params: [id, tabId, action] }) {
      try {
        if (action === "focus") await ctx.webKernel.focusTab(id, tabId);
        else await ctx.webKernel.closeTab(id, tabId);
        return Response.json({ ok: true });
      } catch (error) { return failure(error, 409); }
    },
  },
];
