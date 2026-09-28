export const DEFAULT_MODEL = "xiaomi-token-plan-cn/mimo-v2.6-flash";

/** Providers Alpha uses unless the person allows others in 设置 → 模型. */
export const DEFAULT_MODEL_PROVIDERS: readonly string[] = ["deepseek", "xiaomi-token-plan-cn"];

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID.test(value);
}

// Worker processes are spawned with this process's environment, so the allow-list travels with it.
const ENV = "ALPHA_MODEL_PROVIDERS";
let allowed = new Set<string>(process.env[ENV]?.split(",").filter(isProviderId) ?? []);
if (!allowed.size) allowed = new Set(DEFAULT_MODEL_PROVIDERS);

/** Applies the providers chosen in settings to this process and to workers it starts afterwards. */
export function setAllowedModelProviders(providers: readonly string[]): void {
  const valid = providers.filter(isProviderId);
  allowed = new Set(valid.length ? valid : DEFAULT_MODEL_PROVIDERS);
  process.env[ENV] = [...allowed].join(",");
}

export function isAllowedModelProvider(provider: string, providers: Iterable<string> = allowed): boolean {
  return new Set(providers).has(provider);
}

export function isAllowedModelSelector(selector: string, providers: Iterable<string> = allowed): boolean {
  if (!/^[^\s/]+\/[^\s/]+$/.test(selector)) return false;
  const separator = selector.indexOf("/");
  return isAllowedModelProvider(selector.slice(0, separator), providers);
}
