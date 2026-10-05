import { fuzzyFind, grep, GrepOutputMode } from "@oh-my-pi/pi-natives";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

/** The same native search engine as OMP, with the desktop project's read boundary. */
export async function projectSearch(cwd: string, query: string, content: boolean, signal: AbortSignal) {
  if (!query.trim() || query.length > 500) throw new Error("Search needs 1–500 characters");
  const root = await realpath(cwd);
  const result = content ? await grep({ pattern: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), path: root, ignoreCase: true, mode: GrepOutputMode.Content, maxCount: 200, maxColumns: 300, signal, timeoutMs: 15_000 })
    : await fuzzyFind({ query, path: root, hidden: true, maxResults: 100, signal, timeoutMs: 15_000 });
  const matches = [];
  for (const match of result.matches) {
    const path = await realpath(resolve(root, match.path)).catch(() => ""); const part = relative(root, path);
    if (path && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part) && !part.split(/[\\/]/).includes(".alpha")) matches.push({ ...match, path });
  }
  return { ...result, matches };
}
