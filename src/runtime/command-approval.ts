import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { buildChildEnv } from "./child-env";
import { fingerprintSource } from "./task-ledger";

export interface CommandRequest {
  id: string;
  taskId: string;
  argv: string[];
  purpose: "check" | "other";
  cwd: string;
  status: "pending" | "approved" | "denied" | "running" | "complete" | "uncertain";
  createdAt: string;
  result?: { exitCode: number; logPath: string; revision: string };
}

const parameters = type({ argv: "string[]", purpose: "'check' | 'other'" });

export class CommandApprovalStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly dataRoot: string) {}

  private directory(taskId: string): string { return join(this.dataRoot, "approvals", taskId); }
  private file(taskId: string, id: string): string { return join(this.directory(taskId), `${id}.json`); }

  private async save(request: CommandRequest): Promise<void> {
    await mkdir(this.directory(request.taskId), { recursive: true });
    const file = this.file(request.taskId, request.id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(request, null, 2));
    await rename(temporary, file);
  }

  async list(taskId: string): Promise<CommandRequest[]> {
    const names = (await readdir(this.directory(taskId)).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    return (await Promise.all(names.map(async name => JSON.parse(await readFile(join(this.directory(taskId), name), "utf8")) as CommandRequest))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async reconcile(taskId: string): Promise<void> {
    await this.serial(async () => {
      for (const request of await this.list(taskId)) {
        if (request.status === "running") { request.status = "uncertain"; await this.save(request); }
      }
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  request(taskId: string, cwd: string, argv: string[], purpose: "check" | "other"): Promise<CommandRequest> {
    if (!argv.length || argv.length > 16 || argv.some(arg => typeof arg !== "string" || !arg || arg.length > 1000 || /[\r\n\0]/.test(arg))) throw new Error("Command arguments are invalid");
    return this.serial(async () => {
      const existing = (await this.list(taskId)).find(item => item.cwd === cwd && item.purpose === purpose && JSON.stringify(item.argv) === JSON.stringify(argv));
      if (existing) return existing;
      const request: CommandRequest = { id: randomUUID(), taskId, cwd, argv, purpose, status: "pending", createdAt: new Date().toISOString() };
      await this.save(request);
      return request;
    });
  }

  decide(taskId: string, id: string, approved: boolean): Promise<CommandRequest> {
    return this.serial(async () => {
      const request = (await this.list(taskId)).find(item => item.id === id);
      if (!request || request.status !== "pending") throw new Error("Approval request is not pending");
      request.status = approved ? "approved" : "denied";
      await this.save(request);
      return request;
    });
  }

  async execute(taskId: string, cwd: string, argv: string[], purpose: "check" | "other", signal?: AbortSignal): Promise<CommandRequest> {
    const request = await this.request(taskId, cwd, argv, purpose);
    if (request.status !== "approved") return request;
    await this.serial(async () => {
      const current = (await this.list(taskId)).find(item => item.id === request.id);
      if (current?.status !== "approved") throw new Error("Approved command changed before execution");
      request.status = "running";
      await this.save(request);
    });
    const logDir = join(this.dataRoot, "command-logs");
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${taskId}-${request.id}.log`);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const abort = () => child?.kill();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      signal?.throwIfAborted();
      child = Bun.spawn(argv, { cwd, env: buildChildEnv(), stdout: "pipe", stderr: "pipe" });
      if (!child.stdout || typeof child.stdout === "number" || !child.stderr || typeof child.stderr === "number") throw new Error("Command output is unavailable");
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(abort, 120_000);
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      await writeFile(logPath, `command=${JSON.stringify(argv)}\ncwd=${cwd}\nexit=${exitCode}\n${stdout}\n${stderr}`, { flag: "wx" });
      request.status = "complete";
      request.result = { exitCode, logPath, revision: await fingerprintSource(cwd) };
      await this.save(request);
      return request;
    } catch (error) {
      request.status = "uncertain";
      await this.save(request);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

const stores = new Map<string, CommandApprovalStore>();
export function commandApprovalStore(dataRoot: string): CommandApprovalStore {
  let store = stores.get(dataRoot);
  if (!store) { store = new CommandApprovalStore(dataRoot); stores.set(dataRoot, store); }
  return store;
}

export function createCommandTool(store: CommandApprovalStore, taskId: string, cwd: string): CustomTool<typeof parameters> {
  return {
    name: "alpha_command",
    label: "Request an approved command",
    description: "Request a command outside configured checks. It will not run until the user approves the exact argv in the workbench. The working directory is fixed to this managed project.",
    parameters,
    loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        const result = await store.execute(taskId, cwd, args.argv, args.purpose, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.status !== "complete" || result.result?.exitCode !== 0 };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  };
}
