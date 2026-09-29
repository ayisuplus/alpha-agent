export type NativeModel = { selector: string; provider: string; id: string; name: string; available: boolean; reasoning: boolean; contextWindow: number };
export type NativeCatalog = { models: NativeModel[]; providers: Array<{ id: string; origin: string | null; storedKey: boolean; oauth: boolean; available: number }>; error: string | null };
export type NativeSetting = { id: string; type: string; value: unknown; label: string; description: string; tab: string; group: string; values?: string[]; provenance: string };
export type NativeConfig = { agentDir: string; modelRoles: Record<string, string>; settings: NativeSetting[] };
export function modelPreference(models: NativeModel[], configured: string) {
  if (models.some(model => model.selector === configured)) return { selector: configured, thinking: "" };
  const match = /:(off|minimal|low|medium|high|xhigh|max|auto)$/.exec(configured);
  const selector = match ? configured.slice(0, -match[0].length) : configured;
  return { selector, thinking: match?.[1] ?? "" };
}
export async function nativeApi<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api/native/${path}`, data === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
}
