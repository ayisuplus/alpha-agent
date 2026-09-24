import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { MCPManager, validateServerConfig, type MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";

export interface PluginMCPConfig {
  id: string;
  root: string;
  servers: Record<string, MCPServerConfig>;
}

export async function readPluginMCP(root: string, id: string): Promise<PluginMCPConfig> {
  const file = join(root, ".mcp.json");
  let raw: string;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(file);
    const remainder = relative(canonicalRoot, canonicalFile);
    if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw new Error(`${id} 的 .mcp.json 超出插件目录`);
    raw = await readFile(canonicalFile, "utf8");
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id, root, servers: {} };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`${id} 的 .mcp.json 不是有效 JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${id} 的 .mcp.json 必须是对象`);
  const declared = "mcpServers" in parsed ? parsed.mcpServers : parsed;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) throw new Error(`${id} 的 mcpServers 必须是对象`);
  const servers: Record<string, MCPServerConfig> = {};
  for (const [name, value] of Object.entries(declared).filter(([name]) => name !== "$schema")) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${id} 的 MCP 服务名称或配置无效：${name}`);
    }
    const config = value as MCPServerConfig;
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error(`${id} 的 MCP 启用状态无效：${name}`);
    if (config.enabled === false) continue;
    const errors = validateServerConfig(name, config);
    if (errors.length) throw new Error(`${id} 的 MCP 配置无效：${errors.join("; ")}`);
    if (config.timeout !== undefined && (!Number.isInteger(config.timeout) || config.timeout < 0)) throw new Error(`${id} 的 MCP 超时设置无效：${name}`);
    if ("command" in config && (typeof config.command !== "string" || (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(item => typeof item === "string"))))) {
      throw new Error(`${id} 的 MCP 命令配置无效：${name}`);
    }
    if ("url" in config && typeof config.url !== "string") throw new Error(`${id} 的 MCP 地址无效：${name}`);
    for (const field of ["env", "headers"] as const) {
      const record = (config as unknown as Record<string, unknown>)[field];
      if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record) || !Object.values(record).every(item => typeof item === "string"))) {
        throw new Error(`${id} 的 MCP ${field} 配置无效：${name}`);
      }
    }
    const expand = (text: string) => text.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
    const timeout = Math.min(config.timeout || 10_000, 30_000);
    servers[`alpha_${id}_${name}`] = "command" in config
      ? { ...config, timeout, cwd: config.cwd && expand(config.cwd), command: expand(config.command), args: config.args?.map(expand), env: config.env && Object.fromEntries(Object.entries(config.env).map(([key, item]) => [key, expand(item)])) }
      : { ...config, timeout, url: expand(config.url), headers: config.headers && Object.fromEntries(Object.entries(config.headers).map(([key, item]) => [key, expand(item)])) };
  }
  return { id, root, servers };
}

export async function connectPluginMCP(projectRoot: string, packs: PluginMCPConfig[]): Promise<{ manager: MCPManager; tools: CustomTool[]; errors: string[] }> {
  const manager = new MCPManager(projectRoot, null);
  const configs = Object.assign({}, ...packs.map(pack => Object.fromEntries(Object.entries(pack.servers).map(([name, config]) => [
    name, "command" in config ? { ...config, cwd: config.cwd ?? projectRoot } : config,
  ])))) as Record<string, MCPServerConfig>;
  const sources = Object.fromEntries(packs.flatMap(pack => Object.keys(pack.servers).map(name => [name, {
    provider: "alpha-plugin", providerName: pack.id, path: join(pack.root, ".mcp.json"), level: "user" as const,
  }])));
  const errors: string[] = [];
  try {
    const result = await manager.connectServers(configs, sources, event => {
      if (event.type === "failed") errors.push(`${event.serverName}: ${event.error}`);
    });
    await manager.waitForPendingConnections();
    for (const [name, error] of result.errors) {
      const message = `${name}: ${error}`;
      if (!errors.includes(message)) errors.push(message);
    }
    const tools = manager.getTools();
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`MCP 工具名称冲突：${tool.name}`);
      names.add(tool.name);
    }
    return { manager, tools, errors };
  } catch (error) {
    await manager.disconnectAll();
    throw error;
  }
}
