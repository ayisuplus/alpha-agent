export const DEFAULT_MODEL = "xiaomi-token-plan-cn/mimo-v2.6-flash";

export function isAllowedModelProvider(provider: string): boolean {
  return provider === "deepseek" || provider === "xiaomi-token-plan-cn";
}

export function isAllowedModelSelector(selector: string): boolean {
  if (!/^[^\s/]+\/[^\s/]+$/.test(selector)) return false;
  const separator = selector.indexOf("/");
  return isAllowedModelProvider(selector.slice(0, separator));
}
