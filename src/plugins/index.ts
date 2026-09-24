import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { comfyPlugin, createComfyPlugin, type ComfyPluginOptions } from "./comfyui";

export interface PluginContribution {
  tools: CustomTool[];
  instructions: string[];
}

export interface BuiltinPlugin {
  id: string;
  name: string;
  description: string;
  source: "builtin";
  create(options: ComfyPluginOptions): PluginContribution;
}

export const builtinPlugins: readonly BuiltinPlugin[] = [
  { ...comfyPlugin, create: createComfyPlugin },
];

export function loadBuiltinPlugins(options: Omit<ComfyPluginOptions, "enabled"> & { enabled?: Record<string, boolean> }): PluginContribution {
  const contributions = builtinPlugins.map(plugin => plugin.create({ ...options, enabled: options.enabled?.[plugin.id] ?? true }));
  return {
    tools: contributions.flatMap(plugin => plugin.tools),
    instructions: contributions.flatMap(plugin => plugin.instructions),
  };
}
