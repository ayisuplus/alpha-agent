import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { capabilityPool } from "./capability-pool";

const parameters = type({ query: "string?", kind: "string?" });

export function createCapabilitySearchTool(dataRoot: string): CustomTool<typeof parameters> {
  return {
    name: "alpha_capability_search", label: "Find available capabilities", loadMode: "essential", parameters,
    description: "Search the shared catalog of installed Skills, MCP services and tools, and built-in plugin tools. This reads metadata only; it does not start services or grant access.",
    async execute(_id, args) {
      try {
        const query = args.query?.trim().toLowerCase() ?? "";
        const entries = (await capabilityPool(dataRoot)).filter(item =>
          (!args.kind || item.kind === args.kind) && (!query || `${item.id} ${item.name} ${item.description} ${item.source}`.toLowerCase().includes(query)));
        return { content: [{ type: "text", text: JSON.stringify({ capabilities: entries.slice(0, 40), total: entries.length }) }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
