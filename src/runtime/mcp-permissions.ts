import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";

export type MCPPermission = "deny" | "read" | "write";
interface Receipt { taskId: string; tool: string; requestId: string; argsHash: string; status: "running" | "complete" | "uncertain"; result?: unknown; recordedAt: string }
interface PolicyFile { permissions: Record<string, MCPPermission>; receipts: Record<string, Receipt> }

export class MCPPermissionStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataRoot: string) { this.file = join(resolve(dataRoot), "mcp-permissions.json"); }

  private async read(): Promise<PolicyFile> {
    return JSON.parse(await readFile(this.file, "utf8").catch(() => '{"permissions":{},"receipts":{}}')) as PolicyFile;
  }
  private async write(data: PolicyFile): Promise<void> {
    await mkdir(resolve(this.file, ".."), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2));
    await rename(temp, this.file);
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
  async list(): Promise<Record<string, MCPPermission>> { return { ...(await this.read()).permissions }; }
  async set(tool: string, permission: MCPPermission): Promise<void> {
    if (!/^mcp__[A-Za-z0-9_.-]+$/.test(tool) || !["deny", "read", "write"].includes(permission)) throw new Error("Invalid MCP tool permission");
    await this.mutate(async () => { const data = await this.read(); data.permissions[tool] = permission; await this.write(data); });
  }
  async begin(taskId: string, tool: string, requestId: string, args: unknown): Promise<{ permission: MCPPermission; result?: unknown; repeat: boolean }> {
    if (!requestId || requestId.length > 200) throw new Error("MCP call needs a request ID");
    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    return this.mutate(async () => {
      const data = await this.read();
      const permission = data.permissions[tool] ?? "deny";
      if (permission === "deny") return { permission, repeat: false };
      if (permission === "read") return { permission, repeat: false };
      const key = `${taskId}:${requestId}`;
      const prior = data.receipts[key];
      if (prior) {
        if (prior.tool !== tool || prior.argsHash !== argsHash) throw new Error("MCP request ID was reused for a different action");
        if (prior.status !== "complete") throw new Error("MCP external action outcome is uncertain; review its receipt before retrying");
        return { permission, result: prior.result, repeat: true };
      }
      data.receipts[key] = { taskId, tool, requestId, argsHash, status: "running", recordedAt: new Date().toISOString() };
      await this.write(data);
      return { permission, repeat: false };
    });
  }
  async finish(taskId: string, requestId: string, result: unknown): Promise<void> {
    await this.mutate(async () => {
      const data = await this.read();
      const item = data.receipts[`${taskId}:${requestId}`];
      if (!item || item.status !== "running") throw new Error("MCP receipt is not running");
      item.status = "complete";
      item.result = result;
      item.recordedAt = new Date().toISOString();
      await this.write(data);
    });
  }
  async uncertain(taskId: string, requestId: string): Promise<void> {
    await this.mutate(async () => {
      const data = await this.read();
      const item = data.receipts[`${taskId}:${requestId}`];
      if (item?.status === "running") { item.status = "uncertain"; await this.write(data); }
    });
  }
  async receipts(taskId: string): Promise<Receipt[]> {
    return Object.values((await this.read()).receipts).filter(item => item.taskId === taskId);
  }
  async reconcile(taskId: string): Promise<void> {
    await this.mutate(async () => {
      const data = await this.read();
      let changed = false;
      for (const item of Object.values(data.receipts)) {
        if (item.taskId === taskId && item.status === "running") { item.status = "uncertain"; changed = true; }
      }
      if (changed) await this.write(data);
    });
  }
}

export function guardMCPTools(tools: CustomTool[], store: MCPPermissionStore, taskId: string, onNeedsInput: (question: string) => Promise<void>): CustomTool[] {
  return tools.map(tool => ({ ...tool,
    async execute(callId, args, update, context, signal) {
      try {
        signal?.throwIfAborted();
        const permit = await store.begin(taskId, tool.name, callId, args);
        if (permit.permission === "deny") {
          await onNeedsInput(`MCP 工具 ${tool.name} 尚未逐项授权。请在插件设置中授予只读或外部写入权限。`);
          return { content: [{ type: "text" as const, text: "MCP tool permission required" }], isError: true };
        }
        if (permit.repeat) return permit.result as Awaited<ReturnType<typeof tool.execute>>;
        let result: Awaited<ReturnType<typeof tool.execute>>;
        try { result = await tool.execute(callId, args, update, context, signal); }
        catch (error) {
          if (permit.permission === "write") await store.uncertain(taskId, callId);
          throw error;
        }
        if (permit.permission === "write") await store.finish(taskId, callId, result);
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.includes("outcome is uncertain")) await onNeedsInput(`MCP 工具 ${tool.name} 的外部动作结果不确定。请检查回执和外部系统后决定是否继续。`);
        return { content: [{ type: "text" as const, text: reason }], isError: true };
      }
    },
  }));
}
