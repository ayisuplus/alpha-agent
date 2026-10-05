import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { getLogPath, getLogsDir } from "@oh-my-pi/pi-utils";
import { redact, safeUrl } from "./config-redaction";

export function redactLog(text: string) {
  return text.split("\n").map(line => {
    try { return JSON.stringify(redact(JSON.parse(line))); } catch { return line; }
  }).join("\n")
    .replace(/https?:\/\/[^\s"'<>]+/g, value => safeUrl(value))
    .replace(/\b(Bearer\s+)[\w.+\/-]+/gi, "$1••••")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1••••");
}
/** Read bounded tails of OMP's existing rotating logs; no separate logger or arbitrary file reader. */
export async function nativeLogs(input: Record<string, unknown>) {
  const directory = getLogsDir();
  const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const entries = await Promise.all(names.filter(name => /^omp\.[\d-]+\.\d+\.log$/.test(name)).map(async name => ({ name, ...(await stat(join(directory, name)).then(value => ({ size: value.size, modifiedAt: value.mtime.toISOString() }))) })));
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  if (!input.name) return { directory, current: getLogPath(), entries };
  if (typeof input.name !== "string" || !entries.some(row => row.name === input.name)) throw new Error("Choose a native log from the catalog");
  const root = await realpath(directory), path = await realpath(join(directory, input.name)), part = relative(root, path);
  if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part)) throw new Error("Log leaves its native directory");
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size, start = Math.max(0, size - 262144), buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    return { path, truncated: start > 0, text: redactLog(text) };
  } finally { await file.close(); }
}
