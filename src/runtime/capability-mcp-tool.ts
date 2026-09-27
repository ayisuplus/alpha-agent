import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { SkillPluginStore } from "../plugins/third-party";
import { capabilityPool } from "./capability-pool";
import { guardMCPTools, MCPPermissionStore } from "./mcp-permissions";

const parameters = type({ serverId: "string", action: "'list' | 'call'", toolName: "string?", argsJson: "string?", requestId: "string?" });

export function createCapabilityMCPTool(dataRoot: string, projectRoot: string, taskId: string, onNeedsInput: (reason: string) => Promise<void>): CustomTool<typeof parameters> {
  return {
    name: "alpha_capability_mcp", label: "Use an MCP capability", loadMode: "essential", parameters,
    description: "Open one enabled MCP server from alpha_capability_search only when needed. action=list returns its tools. For action=call, give a selected toolName, JSON object argsJson, and stable requestId. Every call still requires its own read/write permission and external writes keep receipts.",
    async execute(_callId, args, _update, _context, signal) {
      try {
        const server = (await capabilityPool(dataRoot)).find(item => item.id === args.serverId && item.kind === "mcp-server" && item.enabled);
        if (!server) throw new Error("MCP service is unavailable or disabled");
        const connected = await new SkillPluginStore(dataRoot).loadMCP(projectRoot, [server.source]);
        try {
          if (connected.errors.length) throw new Error(connected.errors.join("; "));
          const tools = connected.tools.filter(tool => tool.mcpServerName === server.id);
          if (args.action === "list") {
            const file = join(dataRoot, "mcp-tool-catalog.json");
            const prior = await readFile(file, "utf8").then(value => JSON.parse(value) as Array<{ name: string; server: string; description: string; revision: string }>).catch(() => []);
            const current = tools.map(tool => ({ name: tool.name, server: server.id, description: tool.description, revision: server.revision }));
            const temporary = `${file}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify([...prior.filter(item => !current.some(next => next.name === item.name)), ...current]));
            await rename(temporary, file);
            return { content: [{ type: "text", text: JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))) }] };
          }
          if (!args.toolName || !args.requestId || !args.argsJson || args.argsJson.length > 64_000) throw new Error("MCP call requires toolName, argsJson, and a stable requestId");
          const tool = tools.find(item => item.name === args.toolName);
          if (!tool) throw new Error("MCP tool is not in the selected service");
          const parsed: unknown = JSON.parse(args.argsJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MCP argsJson must be a JSON object");
          const [guarded] = guardMCPTools([tool], new MCPPermissionStore(dataRoot), taskId, onNeedsInput);
          return await guarded.execute(args.requestId, parsed as never, undefined, undefined as never, signal);
        } finally { await connected.manager.disconnectAll(); }
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
