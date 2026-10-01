export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /token|secret|password|authorization|api.?key|^env$|^headers$/i.test(key) ? "••••"
      : /url$/i.test(key) && typeof item === "string" && item !== safeUrl(item) ? "••••" : redact(item)]));
}
export function safeUrl(value: string): string { try { const url = new URL(value); if (!url.username && !url.password && !url.search && !url.hash) return value; url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "••••"; } }
export function preserveRedacted(input: unknown, previous: unknown): unknown {
  if (input === "••••") return previous;
  if (Array.isArray(input)) return input.map((item, index) => preserveRedacted(item, Array.isArray(previous) ? previous[index] : undefined));
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, preserveRedacted(value, previous && typeof previous === "object" ? (previous as Record<string, unknown>)[key] : undefined)]));
}
