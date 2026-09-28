import { DEFAULT_MODEL } from "../../runtime/omp-runner";
import { setAllowedModelProviders } from "../../runtime/model-policy";
import { ModelServiceError, isModelAvailable, listModels, removeApiKey, setApiKey, testModel } from "../../runtime/models";
import { PromptRefinementError, refinePrompt } from "../../runtime/prompt-refinement";
import { SettingsError, isModelSelector, normalizeComfyUrl } from "../../runtime/settings";
import { ComfyClient } from "../../runtime/comfy-client";
import { cleanupStalePreviews, storageReport } from "../../runtime/storage";
import { body, failure, path, type Route } from "../http";

export const settingsRoutes: Route[] = [
  { method: "GET", path: "/api/settings", async handle({ ctx }) { return Response.json({ settings: await ctx.settingsStore.get() }); } },
  {
    method: "PUT", path: "/api/settings",
    async handle({ ctx, request }) {
      try {
        const patch = await body<{ model?: { default?: unknown; translation?: unknown }; workerModels?: { investigate?: unknown; implement?: unknown; review?: unknown } } | null>(request, null);
        const nextDefault = patch?.model?.default;
        if (typeof nextDefault === "string" && isModelSelector(nextDefault) && !(await isModelAvailable(nextDefault))) return Response.json({ error: "这个模型没有可用的认证，不能设为默认" }, { status: 400 });
        const nextTranslation = patch?.model?.translation;
        if (typeof nextTranslation === "string" && isModelSelector(nextTranslation) && !(await isModelAvailable(nextTranslation))) return Response.json({ error: "这个模型没有可用的认证，不能用于翻译" }, { status: 400 });
        for (const mode of ["investigate", "implement", "review"] as const) {
          const selected = patch?.workerModels?.[mode];
          if (typeof selected === "string" && isModelSelector(selected) && !(await isModelAvailable(selected))) return Response.json({ error: "这个模型没有可用的认证，不能用于子代理" }, { status: 400 });
        }
        const settings = await ctx.settingsStore.update(patch);
        setAllowedModelProviders(settings.model.providers);
        ctx.broadcast({ type: "settings", settings });
        return Response.json({ settings });
      } catch (error) {
        if (error instanceof SettingsError) return failure(error);
        throw error;
      }
    },
  },
  {
    method: "GET", path: "/api/models",
    async handle({ ctx }) {
      const settings = await ctx.settingsStore.get();
      return Response.json({ ...await listModels(), default: settings.model.default, builtin: DEFAULT_MODEL });
    },
  },
  {
    method: "POST", path: "/api/models/test",
    async handle({ ctx, request }) {
      const input = await body<{ model?: unknown }>(request, {});
      if (!isModelSelector(input.model)) return Response.json({ error: "请选择要测试的模型" }, { status: 400 });
      return Response.json(await testModel(input.model, ctx.dataRoot));
    },
  },
  ...(["PUT", "DELETE"] as const).map((method): Route => ({
    method, path: path("/api/providers/([A-Za-z0-9._-]{1,80})/key"),
    async handle({ request, params: [provider] }) {
      try {
        if (method === "DELETE") return Response.json({ removed: await removeApiKey(provider) });
        const input = await body<{ apiKey?: unknown }>(request, {});
        await setApiKey(provider, typeof input.apiKey === "string" ? input.apiKey : "");
        return Response.json({ saved: true });
      } catch (error) {
        if (error instanceof ModelServiceError) return failure(error);
        throw error;
      }
    },
  })),
  {
    method: "POST", path: "/api/prompts/refine",
    async handle({ ctx, request }) {
      const input = await body<{ prompt?: unknown; model?: unknown }>(request, {});
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12_000) return Response.json({ error: "请输入 1–12000 字的提示词" }, { status: 400 });
      if (input.model !== undefined && !isModelSelector(input.model)) return Response.json({ error: "优化模型格式不正确" }, { status: 400 });
      const settings = await ctx.settingsStore.get();
      const optimizationModel = typeof input.model === "string" ? input.model : settings.model.default ?? DEFAULT_MODEL;
      const translationModel = settings.model.translation ?? optimizationModel;
      try { return Response.json({ result: await refinePrompt(input.prompt, optimizationModel, translationModel, ctx.dataRoot, undefined, request.signal) }); }
      catch (error) {
        if (error instanceof PromptRefinementError) return failure(error);
        throw error;
      }
    },
  },
  {
    method: "POST", path: "/api/generation/check",
    async handle({ ctx, request }) {
      const input = await body<{ url?: unknown }>(request, {});
      try {
        const comfyUrl = normalizeComfyUrl(typeof input.url === "string" ? input.url : (await ctx.settingsStore.get()).generation.comfyUrl);
        return Response.json({ url: comfyUrl, online: await new ComfyClient(comfyUrl).health() });
      } catch (error) {
        if (error instanceof SettingsError) return failure(error);
        throw error;
      }
    },
  },
  { method: "GET", path: "/api/diagnostics", async handle({ ctx }) { return Response.json(await ctx.diagnostics()); } },
  { method: "GET", path: "/api/storage", async handle({ ctx }) { return Response.json(await storageReport(ctx.dataRoot, ctx.productsRoot, await ctx.protectedPreviewIds())); } },
  {
    method: "POST", path: "/api/storage/cleanup-previews",
    async handle({ ctx }) {
      const lease = ctx.operations.claim("cleanup", { exclusive: true });
      if (!lease) return Response.json({ error: "请等当前操作结束后再清理预览" }, { status: 409 });
      try { return Response.json(await cleanupStalePreviews(ctx.dataRoot, await ctx.protectedPreviewIds())); }
      finally { ctx.operations.release(lease); }
    },
  },
];
