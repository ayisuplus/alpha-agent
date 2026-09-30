export type HostMethod = "catalog" | "extension" | "mode" | "plan" | "tree" | "navigate" | "usage";
export interface HostRequest { type: "alpha_request"; id: string; method: HostMethod; input: Record<string, unknown> }
export interface ExtensionRow {
  kind: "skill" | "mcp" | "plugin"; id: string; name: string; description?: string;
  source: string; scope: string; path?: string; enabled: boolean; loaded: boolean;
  status: string; error?: string; version?: string; license?: string; details?: unknown;
}
export interface ExtensionCatalog { entries: ExtensionRow[]; warnings: string[]; pendingReload?: boolean }
