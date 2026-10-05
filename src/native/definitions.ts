import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { getAgentDir, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { ruleCapability, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { promptCapability, type Prompt } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import { slashCommandCapability, type SlashCommand } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { invalidate } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { discoverRuleFromMarkdown } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverStartupLspServers, getLspStatus, warmupLspServers } from "@oh-my-pi/pi-coding-agent/lsp";
import { shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { configCache } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { isRpcSessionSettled } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { nativeLspConfiguration } from "./lsp-configuration";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";

export interface DefinitionRow { kind: string; name: string; path?: string; source: string; scope: string; loaded: boolean; content?: string; status: string }
const directories: Record<string, string> = { rule: "rules", command: "commands", prompt: "prompts", task: "agents" };
const contained = (root: string, path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part); };
const readOptional = (path: string) => readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });

/** Inventory and edit native files; OMP still discovers, expands and executes every definition. */
export class NativeDefinitions {
  constructor(private session: AgentSession) {}
  private get cwd() { return this.session.sessionManager.getCwd(); }
  async catalog() {
    const options = { cwd: this.cwd, extensionRoots: this.session.effectiveExtensionRoots, disabledExtensions: [] };
    const [rules, commands, prompts, tasks] = await Promise.all([
      loadCapability<Rule>(ruleCapability.id, options), loadCapability<SlashCommand>(slashCommandCapability.id, options),
      loadCapability<Prompt>(promptCapability.id, options), discoverAgents(this.cwd, homedir(), this.session.effectiveExtensionRoots),
    ]);
    const entries: DefinitionRow[] = [];
    for (const [kind, result] of [["rule", rules], ["command", commands], ["prompt", prompts]] as const) for (const item of result.all) {
      const loaded = kind === "rule" ? !!item.content.trim() && (this.session.ttsrManager?.getRules().some(rule => rule.path === item.path && rule.content === item.content) === true || this.session.systemPrompt.some(prompt => prompt.includes(item.content)))
        : kind === "command" ? this.session.slashCommands.some(command => command.name === item.name && command.content === parseFrontmatter(item.content).body)
          : this.session.promptTemplates.some(prompt => prompt.name === item.name && prompt.content === parseFrontmatter(item.content).body);
      entries.push({ kind, name: item.name, path: item.path, scope: item._source.level, source: item._source.provider, loaded, status: loaded ? "loaded" : result.items.includes(item as never) ? "discovered" : "overridden" });
    }
    for (const task of tasks.agents) entries.push({ kind: "task", name: task.name, path: task.filePath, scope: task.source, source: "native", content: task.filePath ? undefined : task.systemPrompt, loaded: false, status: "discovered" });
    return { entries, warnings: [...rules.warnings, ...commands.warnings, ...prompts.warnings].map(String), lsp: { configured: discoverStartupLspServers(this.cwd, "available"), active: getLspStatus() } };
  }
  async request(input: Record<string, unknown>) {
    if (input.action === "list") return this.catalog();
    if (input.action === "lsp-read" || input.action === "lsp-save") return nativeLspConfiguration(this.cwd, input);
    if (input.action === "lsp-start" || input.action === "lsp-stop") {
      if (!isRpcSessionSettled(this.session)) throw new Error("Wait for the session to settle");
      configCache.delete(this.cwd);
      if (input.action === "lsp-stop") await shutdownAll();
      else {
        if (lookup("lsp.enabled")?.get(this.session.settings) !== true) throw new Error("Enable native language services before connecting");
        const result = await warmupLspServers(this.cwd);
        const failed = result.servers.filter(server => server.status === "error");
        if (failed.length) throw new Error(failed.map(server => server.name + ": " + server.error).join("\n"));
      }
      return this.catalog();
    }
    const kind = String(input.kind), name = String(input.name ?? "");
    if (!directories[kind]) throw new Error("Invalid native definition kind");
    if (input.action === "read") {
      const entry = (await this.catalog()).entries.find(row => row.kind === kind && (input.path ? row.path === input.path : row.name === name));
      if (!entry) throw new Error("Definition is no longer discovered");
      return { ...entry, content: entry.path ? await readFile(entry.path, "utf8") : `---\nname: ${entry.name}\ndescription: Native task definition\n---\n${entry.content}` };
    }
    if (input.action !== "save" || !/^[a-zA-Z0-9_-]{1,100}$/.test(name) || typeof input.content !== "string" || input.content.length > 1_000_000) throw new Error("Invalid definition operation");
    const scope = input.scope === "user" ? "user" : "project";
    const root = join(scope === "project" ? join(this.cwd, ".omp") : getAgentDir(), directories[kind]!);
    const path = join(root, name + ".md");
    parseFrontmatter(input.content, { source: path, level: "fatal" });
    if (kind === "task") parseAgent(path, input.content, scope);
    if (kind === "rule") {
      const rule = discoverRuleFromMarkdown(name, input.content, path, { provider: "native", providerName: "Native", path, level: scope });
      if (rule) { const error = ruleCapability.validate?.(rule); if (error) throw new Error(error); }
    }
    if (!input.content.trim()) throw new Error("Definition body cannot be empty");
    await mkdir(root, { recursive: true });
    if (!contained(await realpath(scope === "project" ? this.cwd : getAgentDir()), await realpath(root))) throw new Error("Definition directory escapes its scope");
    const previous = await readOptional(path);
    if (previous !== null && (input.previous !== previous || !contained(await realpath(root), await realpath(path)))) throw new Error("Definition changed or destination already exists; reload before saving");
    const temporary = resolve(dirname(path), "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, input.content, { encoding: "utf8", flag: "wx" });
      if (await readOptional(path) !== previous) throw new Error("Definition changed before saving");
      await replaceFileAtomically(temporary, path); invalidate(path);
    } finally { await rm(temporary, { force: true }); }
    return { path, pendingReload: true };
  }
}
