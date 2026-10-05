import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { YAML } from "bun";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { getConfigDirPaths } from "@oh-my-pi/pi-coding-agent/config";
import { configCache, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { getPreloadedPluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { assertProjectConfigurationScope, replaceNativeConfiguration } from "./configuration";
import { preserveRedacted, redact } from "./config-redaction";

const filenames = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
const readOptional = (path: string) => readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
const revision = (value: string | null) => createHash("sha256").update(value ?? "absent").digest("hex");
/** Only configuration editing lives here. Native loadConfig owns merging, binary checks and project matching. */
export async function nativeLspConfiguration(cwd: string, input: Record<string, unknown>) {
  const scope = input.scope === "user" ? "user" : "project";
  const ownDirectory = scope === "project" ? join(cwd, ".omp") : getAgentDir();
  const candidates = [...new Set([cwd, ...getConfigDirPaths("", { cwd, user: true, project: true }), ...getPreloadedPluginRoots().map(root => root.path), homedir()])].flatMap(directory => filenames.map(name => join(directory, name)));
  const sources: Array<{ path: string; config?: unknown; error?: string; readOnly: boolean }> = [];
  for (const path of candidates) {
    const content = await readOptional(path); if (content === null) continue;
    try { sources.push({ path, config: redact(YAML.parse(content)), readOnly: !path.startsWith(ownDirectory + sep) }); }
    catch (error) { sources.push({ path, error: String(error), readOnly: true }); }
  }
  const path = sources.find(source => !source.readOnly)?.path ?? join(ownDirectory, "lsp.json");
  const previous = await readOptional(path), current = previous === null ? { servers: {} } : YAML.parse(previous);
  if (input.action === "lsp-save") {
    if (input.revision !== revision(previous)) throw new Error("Language service configuration changed; reload before saving");
    const next = preserveRedacted(input.config, current) as Record<string, unknown>;
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Language service configuration must be a mapping");
    const servers = (next.servers ?? Object.fromEntries(Object.entries(next).filter(([key]) => key !== "idleTimeoutMs"))) as Record<string, unknown>;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Language servers must be a mapping");
    for (const [name, server] of Object.entries(servers)) {
      if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("Invalid language server: " + name);
      const value = server as Record<string, unknown>;
      for (const key of ["command", "languageId"]) if (key in value && (typeof value[key] !== "string" || !value[key])) throw new Error("Invalid " + key + ": " + name);
      for (const key of ["args", "fileTypes", "rootMarkers"]) if (key in value && (!Array.isArray(value[key]) || (value[key] as unknown[]).some(item => typeof item !== "string"))) throw new Error("Invalid " + key + ": " + name);
      if ("disabled" in value && typeof value.disabled !== "boolean") throw new Error("Invalid disabled flag: " + name);
    }
    if (scope === "project") await assertProjectConfigurationScope(cwd);
    if (previous !== null) { const part = relative(await realpath(ownDirectory), await realpath(path)); if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part)) throw new Error("Language service configuration is outside its scope"); }
    await replaceNativeConfiguration(path, path.endsWith("json") ? JSON.stringify(next, null, 2) : YAML.stringify(next), previous);
    configCache.delete(cwd);
    return { path, pendingReload: true };
  }
  configCache.delete(cwd);
  return { path, config: redact(current), revision: revision(previous), sources, effective: redact(loadConfig(cwd)) };
}
