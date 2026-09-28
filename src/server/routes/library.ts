import { SkillPluginError } from "../../plugins/third-party";
import type { MCPPermission } from "../../runtime/mcp-permissions";
import { SLUG, body, failure, path, type Route } from "../http";

const presetDetail = path(`/api/agent-presets/${SLUG}`);
const plugin = path(`/api/plugins/${SLUG}`);

export const libraryRoutes: Route[] = [
  {
    method: "GET", path: "/api/agent-presets",
    async handle({ ctx }) { return Response.json({ presets: (await ctx.agentPresetStore.catalog()).map(({ instructions: _instructions, ...item }) => item) }); },
  },
  {
    method: "GET", path: "/api/agent-presets/templates",
    async handle({ ctx }) { return Response.json({ presets: (await ctx.agentPresetStore.templates()).map(({ instructions: _instructions, ...item }) => item) }); },
  },
  {
    method: "GET", path: presetDetail,
    async handle({ ctx, params: [id] }) {
      try { return Response.json({ preset: await ctx.agentPresetStore.get(id) }); }
      catch (error) { return failure(error, 404); }
    },
  },
  {
    method: "POST", path: "/api/agent-presets",
    async handle({ ctx, request }) {
      try { return Response.json({ preset: await ctx.agentPresetStore.create(await request.json() as { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown }) }); }
      catch (error) { return failure(error); }
    },
  },
  {
    method: "POST", path: path(`/api/agent-presets/${SLUG}/copy`),
    async handle({ ctx, params: [id] }) {
      try { return Response.json({ preset: await ctx.agentPresetStore.copy(id) }); }
      catch (error) { return failure(error); }
    },
  },
  {
    method: "PATCH", path: presetDetail,
    async handle({ ctx, request, params: [id] }) {
      try { return Response.json({ preset: await ctx.agentPresetStore.setEnabled(id, (await request.json() as { enabled?: unknown }).enabled as boolean) }); }
      catch (error) { return failure(error); }
    },
  },
  {
    method: "PUT", path: presetDetail,
    async handle({ ctx, request, params: [id] }) {
      try { return Response.json({ preset: await ctx.agentPresetStore.update(id, await request.json() as { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown }) }); }
      catch (error) { return failure(error); }
    },
  },
  {
    method: "DELETE", path: presetDetail,
    async handle({ ctx, params: [id] }) {
      try { await ctx.agentPresetStore.delete(id); return Response.json({ deleted: true }); }
      catch (error) { return failure(error); }
    },
  },
  { method: "GET", path: "/api/plugins", async handle({ ctx }) { return Response.json({ plugins: await ctx.skillPluginStore.list() }); } },
  {
    method: "GET", path: "/api/capabilities",
    async handle({ ctx }) {
      const [plugins, skills] = await Promise.all([ctx.skillPluginStore.list(), ctx.skillPluginStore.loadSkills()]);
      return Response.json({ plugins, skills: skills.map(item => ({ id: item.name, name: item.name.split(":").at(-1), description: item.description })) });
    },
  },
  {
    method: "POST", path: "/api/plugins/install",
    async handle({ ctx, request }) {
      try {
        const input = await body<{ source?: unknown }>(request, {});
        if (typeof input.source !== "string") throw new SkillPluginError("请输入插件仓库地址");
        return Response.json({ plugin: await ctx.skillPluginStore.install(input.source) });
      } catch (error) {
        if (error instanceof SkillPluginError) return failure(error);
        throw error;
      }
    },
  },
  {
    method: "PATCH", path: plugin,
    async handle({ ctx, request, params: [id] }) {
      try {
        const input = await body<{ enabled?: unknown; hooksEnabled?: unknown; mcpEnabled?: unknown }>(request, {});
        if ("hooksEnabled" in input) {
          if (typeof input.hooksEnabled !== "boolean") throw new SkillPluginError("Hook 启用状态必须是布尔值");
          return Response.json({ plugin: await ctx.skillPluginStore.setHooksEnabled(id, input.hooksEnabled) });
        }
        if ("mcpEnabled" in input) {
          if (typeof input.mcpEnabled !== "boolean") throw new SkillPluginError("MCP 启用状态必须是布尔值");
          return Response.json({ plugin: await ctx.skillPluginStore.setMCPEnabled(id, input.mcpEnabled) });
        }
        if (typeof input.enabled !== "boolean") throw new SkillPluginError("启用状态必须是布尔值");
        return Response.json({ plugin: await ctx.skillPluginStore.setEnabled(id, input.enabled) });
      } catch (error) {
        if (error instanceof SkillPluginError) return failure(error);
        throw error;
      }
    },
  },
  {
    method: "POST", path: path(`/api/plugins/${SLUG}/mcp/check`),
    async handle({ ctx, params: [id] }) {
      const item = (await ctx.skillPluginStore.list()).find(candidate => candidate.id === id);
      if (!item || !item.enabled || !item.mcpEnabled) return Response.json({ error: "请先启用插件和 MCP" }, { status: 400 });
      const result = await ctx.skillPluginStore.loadMCP(ctx.productsRoot, item.id);
      try { return Response.json({ tools: result.tools.map(tool => tool.name), errors: result.errors }); }
      finally { await result.manager.disconnectAll(); }
    },
  },
  {
    method: "GET", path: path(`/api/plugins/${SLUG}/mcp/permissions`),
    async handle({ ctx }) { return Response.json({ permissions: await ctx.mcpPermissions.list() }); },
  },
  {
    method: "PUT", path: path(`/api/plugins/${SLUG}/mcp/permissions`),
    async handle({ ctx, request, params: [id] }) {
      const item = (await ctx.skillPluginStore.list()).find(candidate => candidate.id === id);
      if (!item?.enabled || !item.mcpEnabled) return Response.json({ error: "请先启用插件和 MCP" }, { status: 400 });
      const input = await body<{ tool?: unknown; permission?: unknown }>(request, {});
      if (typeof input.tool !== "string" || !input.tool.startsWith(`mcp__alpha_${item.id}_`) || !["deny", "read", "write"].includes(input.permission as string)) return Response.json({ error: "MCP 工具或权限无效" }, { status: 400 });
      await ctx.mcpPermissions.set(input.tool, input.permission as MCPPermission);
      return Response.json({ permissions: await ctx.mcpPermissions.list() });
    },
  },
];

