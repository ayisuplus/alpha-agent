import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TaskLedger } from "../runtime/task-ledger";
import { comfyPlugin, createComfyPlugin, type ComfyPluginOptions } from "./comfyui";
import { officePlugin, createOfficePlugin } from "./office";

type BuiltinOptions = ComfyPluginOptions & { ledger?: TaskLedger; readOnly?: boolean };

export interface PluginContribution {
  tools: CustomTool[];
  instructions: string[];
}

export interface BuiltinPlugin {
  id: string;
  name: string;
  description: string;
  source: "builtin";
  create(options: BuiltinOptions): PluginContribution;
}

export const builtinPlugins: readonly BuiltinPlugin[] = [
  { ...comfyPlugin, create: createComfyPlugin },
  { ...officePlugin, create: createOfficePlugin },
];

export function loadBuiltinPlugins(options: Omit<BuiltinOptions, "enabled"> & { enabled?: Record<string, boolean> }): PluginContribution {
  const contributions = builtinPlugins.map(plugin => plugin.create({ ...options, enabled: options.enabled?.[plugin.id] ?? true }));
  return {
    tools: contributions.flatMap(plugin => plugin.tools),
    instructions: contributions.flatMap(plugin => plugin.instructions),
  };
}
