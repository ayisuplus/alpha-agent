import { join } from "node:path";
import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { isAllowedModelProvider, isAllowedModelSelector } from "./model-policy";

export interface ModelInfo {
  selector: string;
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  reasoning: boolean;
  tools: boolean;
  images: boolean;
  available: boolean;
}

export interface ProviderInfo {
  id: string;
  /** Where the provider's credential comes from, when it has one. */
  origin: "api_key" | "oauth" | "env" | "config" | "runtime" | "fallback" | null;
  envVar?: string;
  /** Whether Alpha can remove a key for it: only stored API keys, never OAuth logins or environment variables. */
  storedKey: boolean;
  models: number;
  available: number;
}

export class ModelServiceError extends Error {}

/**
 * OMP's shared credential store (also used by the OMP command line). Tests point ALPHA_OMP_AGENT_DIR at a temporary
 * directory so they never touch the real one.
 */
export async function ompRegistry() {
  const agentDir = process.env.ALPHA_OMP_AGENT_DIR;
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = agentDir ? new ModelRegistry(authStorage, join(agentDir, "models.yml")) : new ModelRegistry(authStorage);
  return { authStorage, modelRegistry };
}

export async function listModels(): Promise<{ models: ModelInfo[]; providers: ProviderInfo[] }> {
  const { authStorage, modelRegistry } = await ompRegistry();
  try {
    const available = new Set(modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`));
    const models: ModelInfo[] = modelRegistry.getAll("chat")
      .filter(model => isAllowedModelProvider(model.provider) && model.supportsTools !== false)
      .map(model => ({
        selector: `${model.provider}/${model.id}`,
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow ?? null,
        reasoning: model.reasoning === true,
        tools: model.supportsTools !== false,
        images: model.input.includes("image"),
        available: available.has(`${model.provider}/${model.id}`),
      }))
      .sort((a, b) => Number(b.available) - Number(a.available) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    const providers = new Map<string, ProviderInfo>();
    for (const model of models) {
      let provider = providers.get(model.provider);
      if (!provider) {
        const origin = authStorage.getCredentialOrigin(model.provider);
        const stored = authStorage.listStoredCredentials(model.provider);
        provider = {
          id: model.provider,
          origin: origin?.kind ?? null,
          envVar: origin?.envVar,
          storedKey: stored.some(row => row.credential.type === "api_key"),
          models: 0,
          available: 0,
        };
        providers.set(model.provider, provider);
      }
      provider.models++;
      if (model.available) provider.available++;
    }
    return { models, providers: [...providers.values()].sort((a, b) => Number(b.available > 0) - Number(a.available > 0) || a.id.localeCompare(b.id)) };
  } finally {
    authStorage.close();
  }
}

export async function isModelAvailable(selector: string): Promise<boolean> {
  if (!isAllowedModelSelector(selector)) return false;
  const { authStorage, modelRegistry } = await ompRegistry();
  try { return modelRegistry.getAvailable().some(model => `${model.provider}/${model.id}` === selector); }
  finally { authStorage.close(); }
}

/** One tiny prompt with no tools; costs a single short model call. */
export async function testModel(selector: string, dataRoot: string, timeoutMs = 30_000): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  if (!isAllowedModelSelector(selector)) return { ok: false, latencyMs: 0, error: "Alpha 不支持这个模型服务商" };
  const { authStorage, modelRegistry } = await ompRegistry();
  const started = performance.now();
  try {
    const model = modelRegistry.getAvailable().find(item => `${item.provider}/${item.id}` === selector);
    if (!model) return { ok: false, latencyMs: 0, error: "这个模型没有可用的认证" };
    const { session } = await createAgentSession({
      cwd: dataRoot,
      agentDir: join(dataRoot, "omp"),
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: model.provider === "xiaomi-token-plan-cn" ? "off" : undefined,
      sessionManager: SessionManager.inMemory(dataRoot),
      systemPrompt: "You are a connectivity check. Reply with exactly: ALPHA_OK",
      toolNames: [],
      restrictToolNames: true,
      disableExtensionDiscovery: true,
      enableMCP: false,
      enableLsp: false,
      skipPythonPreflight: true,
      skills: [],
      rules: [],
      contextFiles: [],
      promptTemplates: [],
      slashCommands: [],
    });
    const timer = setTimeout(() => void session.abort(), timeoutMs);
    try {
      await session.prompt("Reply with exactly: ALPHA_OK");
      const last = session.getLastAssistantMessage();
      if (last?.stopReason === "error" || last?.stopReason === "aborted") {
        return { ok: false, latencyMs: Math.round(performance.now() - started), error: last.errorMessage ?? (last.stopReason === "aborted" ? `超过 ${timeoutMs / 1000} 秒没有响应` : "模型返回错误") };
      }
      if (!last?.content.some(part => part.type === "text" && part.text.includes("ALPHA_OK"))) {
        return { ok: false, latencyMs: Math.round(performance.now() - started), error: "模型未返回预期内容" };
      }
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
      await session.dispose();
    }
  } catch (error) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  } finally {
    authStorage.close();
  }
}

async function knownProvider(provider: string) {
  if (!isAllowedModelProvider(provider)) throw new ModelServiceError("没有这个模型服务商");
  const services = await ompRegistry();
  if (!services.modelRegistry.getAll("chat").some(model => model.provider === provider)) {
    services.authStorage.close();
    throw new ModelServiceError("没有这个模型服务商");
  }
  return services;
}

export async function setApiKey(provider: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed.length < 8 || /\s/.test(trimmed)) throw new ModelServiceError("API Key 格式不正确");
  const { authStorage } = await knownProvider(provider);
  try {
    // Storing a credential replaces all of the provider's stored credentials, so an OAuth login is never overwritten.
    if (authStorage.listStoredCredentials(provider).some(row => row.credential.type === "oauth")) {
      throw new ModelServiceError("这个服务商已通过 OAuth 登录，请在 OMP 命令行中管理");
    }
    await authStorage.set(provider, { type: "api_key", key: trimmed });
  } finally {
    authStorage.close();
  }
}

export async function removeApiKey(provider: string): Promise<number> {
  const { authStorage } = await knownProvider(provider);
  try {
    let removed = 0;
    for (const row of authStorage.listStoredCredentials(provider)) {
      if (row.credential.type === "api_key" && await authStorage.removeCredential(provider, row.id)) removed++;
    }
    return removed;
  } finally {
    authStorage.close();
  }
}
