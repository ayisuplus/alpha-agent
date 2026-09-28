import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { warnUnknownStoreVersion } from "./store-tag";

/** The discovered MCP tools a capability run may expose; a cache, rebuilt by listing a plugin's MCP server. */
export interface CatalogTool { name: string; server: string; description: string; revision: string }

/** `.alpha/mcp-tool-catalog.json`: a v1 envelope so the file carries its own format tag; bumping v1 needs a migration. */
interface ToolCatalogDocument { tools: CatalogTool[]; format: "mcp-tool-catalog"; version: 1 }

const FILE = "mcp-tool-catalog.json";

export async function readToolCatalog(dataRoot: string): Promise<CatalogTool[]> {
  const text = await readFile(join(dataRoot, FILE), "utf8").catch(() => "");
  if (!text.trim()) return [];
  const parsed = JSON.parse(text) as ToolCatalogDocument | CatalogTool[];
  if (Array.isArray(parsed)) return parsed;               // a file written before the envelope
  warnUnknownStoreVersion("mcp-tool-catalog", parsed);
  return parsed.tools ?? [];
}

export async function writeToolCatalog(dataRoot: string, tools: CatalogTool[]): Promise<void> {
  const file = join(dataRoot, FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ tools, format: "mcp-tool-catalog", version: 1 }));
  await rename(temporary, file);
}
