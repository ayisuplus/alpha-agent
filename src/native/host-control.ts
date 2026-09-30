import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, type CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getMCPConfigPath, getPluginsNodeModules, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { loadAllMCPConfigs, validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { addMCPServer, updateMCPServer, removeMCPServer, setMcpServerEnabled, validateServerName, readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { isRpcSessionSettled } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import { NativeMcpOAuth } from "./mcp-oauth";
import { loadCapability, type Skill as DiscoveredSkill } from "@oh-my-pi/pi-coding-agent/discovery";
import { skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { ExtensionCatalog, ExtensionRow, HostMethod } from "./host-types";
import { NativePlanHost } from "./plan-host";

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|authorization|api.?key|^env$|^headers$/i.test(key) ? "••••" : key === "url" && typeof item === "string" && item !== safeUrl(item) ? "••••" : redact(item)]));
}
function safeUrl(value: string): string { try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "••••"; } }
function needsAdaptation(pkg: Record<string, unknown>): boolean { return !pkg.omp && !pkg.pi && (!!pkg.opencode || Object.keys({ ...pkg.dependencies as object, ...pkg.peerDependencies as object }).some(name => name.startsWith("@opencode-ai/"))); }
export function preserveRedacted(input: unknown, previous: unknown): unknown {
  if (input === "••••") return previous;
  if (Array.isArray(input)) return input.map((item, index) => preserveRedacted(item, Array.isArray(previous) ? previous[index] : undefined));
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, preserveRedacted(value, previous && typeof previous === "object" ? (previous as Record<string, unknown>)[key] : undefined)]));
}
const text = (input: Record<string, unknown>, key: string) => { const value = input[key]; if (typeof value !== "string" || !value.trim()) throw new Error("Missing " + key); return value.trim(); };
const contained = (root: string, path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part); };

export class NativeHostControl {
  private oauth = new NativeMcpOAuth();
  readonly plan: NativePlanHost;
  constructor(readonly runtime: CreateAgentSessionResult, emit: (frame: Record<string, unknown>) => void = () => {}) { this.plan = new NativePlanHost(runtime.session, emit); }
  private get session() { return this.runtime.session; }
  private get cwd() { return this.session.sessionManager.getCwd(); }
  async request(method: HostMethod, input: Record<string, unknown> = {}): Promise<unknown> {
    if (method === "catalog") return this.catalog();
    if (method === "mode") return this.plan.view();
    if (method === "plan") return this.plan.request(input);
    if (method === "tree") return this.session.sessionManager.getTree();
    if (method === "usage") return { usage: this.session.getContextUsage(), stats: this.session.getSessionStats() };
    if (method === "navigate") {
      if (!isRpcSessionSettled(this.session)) throw new Error("Wait for the session to settle");
      const result = await this.session.navigateTree(text(input, "entryId"), { summarize: input.summarize === true });
      if (!result.cancelled) await this.plan.restore();
      return result;
    }
    if (method === "session") {
      if (input.action === "queues") return this.session.getQueuedMessages();
      if (input.action === "clear-queue") return this.session.clearQueue();
      if (input.action === "branch") {
        if (!isRpcSessionSettled(this.session)) throw new Error("Wait for the session to settle");
        return this.session.branch(text(input, "entryId"));
      }
      if (input.action === "label") { this.session.sessionManager.appendLabelChange(text(input, "entryId"), typeof input.label === "string" ? input.label.trim() || undefined : undefined); await this.session.sessionManager.flush(); return { ok: true }; }
      if (input.action === "role") { this.session.settings.setModelRole(text(input, "role"), text(input, "model")); await this.session.settings.flush(); return { ok: true }; }
      throw new Error("Unsupported session action");
    }
    if (method !== "extension") throw new Error("Unknown host method");
    const result = await this.extension(input);
    return { result, pendingReload: !["read", "references", "doctor", "reconnect", "refresh", "resource", "oauth", "oauth-status", "oauth-code", "oauth-cancel"].includes(String(input.action)) };
  }
  async catalog(): Promise<ExtensionCatalog> {
    const entries: ExtensionRow[] = [];
    const active = new Set(this.session.skills.map(skill => skill.filePath));
    const discovered = await loadSkills({ ...this.session.skillsSettings, cwd: this.cwd, disabledExtensions: [], extensionRoots: this.session.effectiveExtensionRoots });
    for (const skill of discovered.skills) entries.push({ kind: "skill", id: skill.filePath, name: skill.name, description: skill.description,
      path: skill.filePath, source: skill.source, scope: skill._source?.level ?? "user", enabled: active.has(skill.filePath), loaded: active.has(skill.filePath), status: active.has(skill.filePath) ? "loaded" : "disabled" });
    const raw = await loadCapability<DiscoveredSkill>(skillCapability.id, { cwd: this.cwd, disabledExtensions: [], extensionRoots: this.session.effectiveExtensionRoots });
    for (const skill of raw.all) if (!entries.some(row => row.id === skill.path)) entries.push({ kind: "skill", id: skill.path, name: skill.name, description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : "", path: skill.path, source: skill._source.provider, scope: skill._source.level, enabled: false, loaded: false, status: discovered.skills.some(winner => winner.name === skill.name) ? "overridden" : "disabled" });
    const configs = await loadAllMCPConfigs(this.cwd, { extensionRoots: this.session.effectiveExtensionRoots, filterExa: false, filterBrowser: false });
    const manager = this.runtime.mcpManager;
    const startup = await manager?.waitForStartup(1);
    for (const [name, config] of Object.entries(configs.configs)) {
      const source = configs.sources[name]; const connection = manager?.getConnection(name);
      const failure = startup?.failed.find(item => item.name === name)?.error;
      const enabled = config.enabled !== false;
      entries.push({ kind: "mcp", id: name, name, source: source?.provider ?? "native", scope: source?.level ?? "user", path: source?.path,
        enabled, loaded: !!connection?.tools, status: enabled ? manager?.getConnectionStatus(name) ?? "disconnected" : "disabled", error: failure,
        details: { config: redact(config), endpoint: "url" in config ? safeUrl(config.url) : undefined, tools: connection?.tools?.map(tool => ({ name: tool.name, description: tool.description })), resources: manager?.getServerResources(name), prompts: manager?.getServerPrompts(name) } });
    }
    const plugins = new PluginManager(this.cwd);
    const enabledPlugins = await getEnabledPlugins(this.cwd);
    const allPlugins = new Map((await plugins.list()).map(plugin => [plugin.name, { ...plugin, scope: "user" }]));
    for (const plugin of enabledPlugins) if (plugin.scope === "project") allPlugins.set(plugin.name, plugin);
    for (const plugin of allPlugins.values()) {
      const pkg = await readFile(join(plugin.path, "package.json"), "utf8").then(JSON.parse).catch(() => ({}));
      const loaded = this.runtime.extensionsResult.extensions.some(extension => contained(plugin.path, extension.path)) || this.session.skills.some(skill => contained(plugin.path, skill.filePath));
      const settings = await plugins.getPluginSettings(plugin.name);
      const manifest = structuredClone(plugin.manifest);
      for (const [key, schema] of Object.entries(manifest.settings ?? {})) if (schema.secret) { if (key in settings) settings[key] = "••••"; delete schema.default; }
      entries.push({ kind: "plugin", id: plugin.name, name: plugin.name, version: plugin.version, license: pkg.license, source: plugin.path, path: plugin.path, scope: plugin.scope, enabled: plugin.enabled, loaded, status: needsAdaptation(pkg) ? "needs_adaptation" : loaded ? "loaded" : plugin.enabled ? "configured" : "disabled", details: { manifest, settings: redact(settings), features: plugin.enabledFeatures } });
    }
    const bundled = resolve(import.meta.dir, "../../presets/alpha-plugin");
    const manifest = JSON.parse(await readFile(join(bundled, ".claude-plugin/plugin.json"), "utf8"));
    entries.push({ kind: "plugin", id: "bundled:alpha", name: "Alpha", description: manifest.description, version: manifest.version, source: bundled, path: bundled, scope: "bundled", enabled: true,
      loaded: this.session.skills.some(skill => contained(bundled, skill.filePath)), status: this.session.skills.some(skill => contained(bundled, skill.filePath)) ? "bundled" : "configured" });
    for (const row of entries) if (row.kind === "skill" && row.path && contained(bundled, row.path)) row.scope = "bundled";
    return { entries, warnings: [...discovered.warnings.map(warning => warning.message), ...this.runtime.extensionsResult.errors.map(error => error.error)] };
  }
  private target(scope: unknown, leaf: string) { return join(scope === "project" ? join(this.cwd, ".omp") : getAgentDir(), leaf); }
  private async extension(input: Record<string, unknown>) {
    const kind = text(input, "kind"), action = text(input, "action");
    if (kind === "skill") {
      if (action === "read" || action === "references") {
        const found = (await this.catalog()).entries.find(row => row.kind === "skill" && row.id === input.id);
        if (!found?.path) throw new Error("Skill not discovered by native runtime");
        const root = await realpath(dirname(found.path));
        if (action === "references") return { files: (await readdir(root, { recursive: true, withFileTypes: true })).filter(item => item.isFile()).map(item => relative(root, join(item.parentPath, item.name))) };
        const file = await realpath(resolve(root, typeof input.reference === "string" ? input.reference : "SKILL.md"));
        if (!contained(root, file)) throw new Error("Reference escapes skill directory");
        if ((await stat(file)).size > 1_000_000) throw new Error("Skill reference too large");
        return { content: await readFile(file, "utf8"), path: file };
      }
      if (action === "toggle") {
        const disabled = lookup("disabledExtensions"); if (!disabled) throw new Error("Native disable setting unavailable");
        const value = disabled.get(this.session.settings) as string[];
        const id = "skill:" + text(input, "name");
        disabled.set(this.session.settings, input.enabled === true ? value.filter(item => item !== id) : [...new Set([...value, id])]);
        await this.session.settings.flush(); return;
      }
      const name = text(input, "name"); if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid skill name");
      const root = this.target(input.scope, "skills"); const destination = join(root, name);
      if (action === "import") {
        if (await stat(destination).then(() => true, () => false)) throw new Error("Skill destination already exists");
        const source = await realpath(text(input, "path"));
        const scanned = await scanSkillsFromDir({ cwd: this.cwd, home: getAgentDir(), repoRoot: null }, { dir: source, providerId: "native", level: "user", requireDescription: true, includeSelf: true });
        if (!scanned.items.some(skill => skill.name === name && resolve(skill.path) === join(source, "SKILL.md"))) throw new Error(scanned.warnings?.join("\n") || "Skill name not found in directory");
        await mkdir(root, { recursive: true }); await cp(source, destination, { recursive: true, dereference: false }); return;
      }
      if (action === "save") {
        await mkdir(destination, { recursive: true });
        const realDestination = await realpath(destination); const realRoot = await realpath(root);
        if (!contained(realRoot, realDestination)) throw new Error("Skill path escapes its directory");
        const content = String(input.content ?? "");
        const metadata = parseFrontmatter(content).frontmatter;
        if (metadata.name !== name || typeof metadata.description !== "string" || !metadata.description.trim()) throw new Error("Skill requires matching name and description frontmatter");
        const file = join(destination, "SKILL.md");
        const previous = await readFile(file, "utf8").catch(() => null);
        if (previous !== null && input.previous !== previous) throw new Error("Skill changed since opening; reload before saving");
        if (previous !== null && !contained(realRoot, await realpath(file))) throw new Error("Skill file escapes its directory");
        await writeFile(file, content, "utf8"); return;
      }
      throw new Error("Unsupported skill action");
    }
    if (kind === "mcp") {
      const name = text(input, "name"); const invalid = validateServerName(name); if (invalid) throw new Error(invalid);
      const manager = this.runtime.mcpManager;
      if (action === "oauth-status") return this.oauth.state();
      if (action === "oauth-code") { this.oauth.code(text(input, "code")); return this.oauth.state(); }
      if (action === "oauth-cancel") { this.oauth.cancel(); return this.oauth.state(); }
      if (action === "oauth") {
        await manager?.waitForStartup(30_000);
        const config = manager?.getServerConfig(name) ?? (await loadAllMCPConfigs(this.cwd, { extensionRoots: this.session.effectiveExtensionRoots, filterExa: false, filterBrowser: false })).configs[name];
        if (!config) throw new Error("Native MCP server not found");
        return this.oauth.start(this.session, name, config);
      }
      if (action === "resource") { if (!manager?.getConnection(name)) throw new Error("MCP server not connected"); const result = await manager.readServerResource(name, text(input, "uri")); if (!result) throw new Error("MCP resource unavailable"); return result; }
      if (action === "reconnect") { if (!manager) throw new Error("MCP disabled"); const result = await manager.reconnectServer(name, { manual: true }); if (!result?.tools) throw new Error("MCP reconnect failed; check server diagnostics"); return; }
      if (action === "refresh") { if (!manager) throw new Error("MCP disabled"); await manager.refreshServerTools(name); return; }
      const userPath = getMCPConfigPath("user", this.cwd), projectPath = getMCPConfigPath("project", this.cwd);
      if (action === "toggle") { await setMcpServerEnabled({ userPath, projectPath, name, enabled: input.enabled === true }); return; }
      const file = input.scope === "project" ? projectPath : userPath;
      if (action === "remove") { await removeMCPServer(file, name); return; }
      const existing = (await loadAllMCPConfigs(this.cwd, { filterExa: false, extensionRoots: this.session.effectiveExtensionRoots })).configs[name];
      const config = preserveRedacted(input.config, existing) as MCPServerConfig;
      if (!config || typeof config !== "object") throw new Error("Invalid MCP configuration");
      const errors = validateServerConfig(name, config); if (errors.length) throw new Error(errors.join("\n"));
      if (action === "add") await addMCPServer(file, name, config);
      else if (action === "save") { if ((await readMCPConfigFile(file)).mcpServers?.[name]) await updateMCPServer(file, name, config); else await addMCPServer(file, name, config); }
      else throw new Error("Unsupported MCP action");
      return;
    }
    if (kind === "plugin") {
      const manager = new PluginManager(this.cwd);
      if (action === "install" || action === "upgrade" || action === "link") {
        const name = action !== "link" ? text(input, "name") : "";
        const linked = action === "upgrade" && await lstat(join(getPluginsNodeModules(), name)).then(item => item.isSymbolicLink(), () => false);
        const plugin = action === "link" || linked ? await manager.link(action === "link" ? text(input, "path") : await realpath(join(getPluginsNodeModules(), name))) : await manager.install(name);
        const pkg = JSON.parse(await readFile(join(plugin.path, "package.json"), "utf8"));
        if (needsAdaptation(pkg)) { await manager.setEnabled(plugin.name, false); throw new Error("OpenCode plugin installed disabled: native interface adaptation required"); }
        return;
      }
      if (action === "doctor") return manager.doctor();
      const name = text(input, "name"); if (name === "bundled:alpha") throw new Error("Bundled plugin is managed by Alpha updates");
      if (action === "remove") await manager.uninstall(name);
      else if (action === "toggle") {
        const plugin = await manager.getPlugin(name);
        if (!plugin) throw new Error("Native plugin not found");
        const pkg = JSON.parse(await readFile(join(plugin.path, "package.json"), "utf8"));
        if (input.enabled === true && needsAdaptation(pkg)) throw new Error("OpenCode plugin requires native interface adaptation");
        await manager.setEnabled(name, input.enabled === true);
      }
      else if (action === "features") await manager.setEnabledFeatures(name, input.features as string[] | null);
      else if (action === "setting") await manager.setPluginSetting(name, text(input, "key"), input.value);
      else throw new Error("Unsupported plugin action");
      return;
    }
    throw new Error("Unknown extension kind");
  }
}
