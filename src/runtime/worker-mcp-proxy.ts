import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";

export interface WorkerMCPDescriptor {
  name: string;
  label: string;
  description: string;
  parameters: CustomTool["parameters"];
  server: string;
}

export interface WorkerMCPRequest {
  id: string;
  name: string;
  callId: string;
  args: unknown;
}

export function parseWorkerMCPRequest(value: unknown, id: string, allowed: ReadonlySet<string>): WorkerMCPRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid worker MCP request");
  const item = value as Partial<WorkerMCPRequest>;
  if (item.id !== id || typeof item.name !== "string" || !allowed.has(item.name) || typeof item.callId !== "string" || !item.callId || !item.args || typeof item.args !== "object" || Array.isArray(item.args)) throw new Error("Worker MCP request is not in its selected tool set");
  return item as WorkerMCPRequest;
}

export function createWorkerMCPProxyTools(directory: string, descriptors: WorkerMCPDescriptor[]): CustomTool[] {
  return descriptors.map(descriptor => ({
    name: descriptor.name, label: descriptor.label, description: descriptor.description,
    parameters: descriptor.parameters, mcpServerName: descriptor.server, loadMode: "essential",
    async execute(callId, args, _update, _ctx, signal) {
      const id = randomUUID();
      const request = join(directory, `${id}.request.json`);
      const response = join(directory, `${id}.response.json`);
      try {
        await writeFile(request, JSON.stringify({ id, name: descriptor.name, callId, args }), { flag: "wx" });
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          const value = await readFile(response, "utf8").catch(() => null);
          if (value !== null) return JSON.parse(value) as Awaited<ReturnType<CustomTool["execute"]>>;
          await Bun.sleep(50);
        }
        throw new Error(`MCP proxy timed out: ${descriptor.name}`);
      } catch (error) {
        await writeFile(join(directory, `${id}.cancel`), "", { flag: "wx" }).catch(() => undefined);
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  }));
}

export async function writeWorkerMCPResponse(directory: string, id: string, result: unknown): Promise<void> {
  const response = join(directory, `${id}.response.json`);
  const temporary = `${response}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { flag: "wx" });
  await rename(temporary, response);
}
