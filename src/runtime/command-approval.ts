import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { buildChildEnv } from "./child-env";
import { fingerprintSource } from "./task-ledger";
import { runFullAccessCommand, runSandboxCommand, SandboxUnavailableError } from "./sandbox-exec";
import type { PermissionMode } from "./task-ledger";

export interface CommandRequest {
  id: string;
  taskId: string;
  argv: string[];
  purpose: "check" | "other";
  cwd: string;
  network?: boolean;
  scriptCommand?: string;
  status: "pending" | "approved" | "denied" | "running" | "complete" | "uncertain";
  createdAt: string;
  reason?: string;
  risk?: "normal" | "high";
  review?: { reviewer: "user" | "independent-agent" | "policy"; decision: "approved" | "denied" | "escalated"; reason: string; at: string };
  exactAction?: { tool: string; targets: string[]; arguments: Record<string, unknown>; digest: string };
  result?: { exitCode: number; logPath: string; revision: string };
}

export type IndependentReview = (request: CommandRequest, signal?: AbortSignal) => Promise<{ decision: "approve" | "deny" | "user"; reason: string }>;

export function commandRisk(argv: string[]): "normal" | "high" {
  const text = argv.join(" ").toLowerCase();
  return /(?:^|[\s;&|])(?:del|erase|rd|rmdir|rm|rimraf|remove-item|format|diskpart|reg(?:\.exe)?|schtasks|sc(?:\.exe)?|net(?:\.exe)?|icacls|takeown|git\s+push|git\s+reset\s+--hard|npm\s+publish|bun\s+publish|curl(?:\.exe)?.*(?:-t|--upload-file|--data|-d)|invoke-restmethod|start-process\s+-verb\s+runas)(?:[\s;&|]|$)/i.test(text)
    || /(?:[\\/"']|^)(?:\.ssh|\.aws|\.azure|\.codex|\.env(?:\.[^\\/\s"']*)?|credentials?(?:\.[^\\/\s"']*)?|id_(?:rsa|ed25519)|\.npmrc)(?:[\\/\s"']|$)/i.test(text)
    ? "high" : "normal";
}

async function scriptCommand(cwd: string, argv: string[]): Promise<string | undefined> {
  if (argv[1] !== "run" || !argv[2]) return undefined;
  const name = argv[2];
  const file = await readFile(join(cwd, "package.json"), "utf8").catch(() => null);
  if (!file) return undefined;
  const script = (JSON.parse(file) as { scripts?: Record<string, unknown> }).scripts?.[name];
  return typeof script === "string" ? script : undefined;
}

const parameters = type({ argv: "string[]", purpose: "'check' | 'other'", "network?": "boolean" });

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

  request(taskId: string, cwd: string, argv: string[], purpose: "check" | "other", network = false): Promise<CommandRequest> {
    if (!argv.length || argv.length > 16 || argv.some(arg => typeof arg !== "string" || !arg || arg.length > 1000 || /[\r\n\0]/.test(arg))) throw new Error("Command arguments are invalid");
    return this.serial(async () => {
      const script = await scriptCommand(cwd, argv);
      const existing = (await this.list(taskId)).find(item => item.status !== "complete" && item.cwd === cwd && item.purpose === purpose && !!item.network === network && item.scriptCommand === script && JSON.stringify(item.argv) === JSON.stringify(argv));
      if (existing) return existing;
      const risk = commandRisk([...argv, ...(script ? [script] : [])]);
      const request: CommandRequest = { id: randomUUID(), taskId, cwd, argv, purpose, network, ...(script ? { scriptCommand: script } : {}), status: "pending", createdAt: new Date().toISOString(), reason: network ? "Command requests network access" : "Command is not a configured project check", risk };
      await this.save(request);
      return request;
    });
  }

  decide(taskId: string, id: string, approved: boolean): Promise<CommandRequest> {
    return this.serial(async () => {
      const request = (await this.list(taskId)).find(item => item.id === id);
      if (!request || request.status !== "pending") throw new Error("Approval request is not pending");
      request.status = approved ? "approved" : "denied";
      request.review = { reviewer: "user", decision: approved ? "approved" : "denied", reason: "Workbench decision", at: new Date().toISOString() };
      await this.save(request);
      return request;
    });
  }

  async requestAction(taskId: string, cwd: string, action: { tool: string; targets: string[]; arguments: Record<string, unknown>; digest: string }, reason: string): Promise<CommandRequest> {
    const request = await this.request(taskId, cwd, ["alpha-file", action.tool, action.targets.join(", ").slice(0, 400), action.digest], "other");
    if (request.exactAction) return request;
    return this.serial(async () => {
      request.exactAction = action;
      request.risk = "high";
      request.reason = reason;
      await this.save(request);
      return request;
    });
  }

  claimAction(taskId: string, id: string): Promise<CommandRequest> {
    return this.serial(async () => {
      const request = (await this.list(taskId)).find(item => item.id === id);
      if (!request || !request.exactAction || request.status !== "approved") throw new Error("File approval is not available for one-time execution");
      request.status = "running";
      await this.save(request);
      return request;
    });
  }

  finishAction(taskId: string, id: string, success: boolean, revision: string): Promise<CommandRequest> {
    return this.serial(async () => {
      const request = (await this.list(taskId)).find(item => item.id === id);
      if (!request || request.status !== "running") throw new Error("File approval was not running");
      request.status = success ? "complete" : "uncertain";
      request.result = { exitCode: success ? 0 : 1, logPath: this.file(taskId, id), revision };
      await this.save(request);
      return request;
    });
  }

  async execute(taskId: string, cwd: string, argv: string[], purpose: "check" | "other", signal?: AbortSignal, permission?: { mode: PermissionMode; roots: string[] }, reviewer?: IndependentReview, network = false): Promise<CommandRequest> {
    signal?.throwIfAborted();
    const request = await this.request(taskId, cwd, argv, purpose, network);
    if (network && permission?.mode !== "full" && request.risk !== "high") {
      request.risk = "high";
      await this.serial(() => this.save(request));
    }
    if (request.status === "pending" && permission && request.risk !== "high") {
      if (permission.mode === "full") {
        await this.serial(async () => {
          request.status = "approved";
          request.review = { reviewer: "policy", decision: "approved", reason: "Full-access mode permits a command not classified as high risk", at: new Date().toISOString() };
          await this.save(request);
        });
      } else if (permission.mode === "auto") {
        if (!reviewer) throw new Error("Independent reviewer is unavailable");
        let review: Awaited<ReturnType<IndependentReview>>;
        try { review = await reviewer(request, signal); }
        catch (error) {
          request.reason = `Independent reviewer unavailable: ${error instanceof Error ? error.message : String(error)}`;
          await this.serial(() => this.save(request));
          return request;
        }
        signal?.throwIfAborted();
        await this.serial(async () => {
          request.status = review.decision === "approve" ? "approved" : review.decision === "deny" ? "denied" : "pending";
          request.review = { reviewer: "independent-agent", decision: review.decision === "approve" ? "approved" : review.decision === "deny" ? "denied" : "escalated", reason: review.reason, at: new Date().toISOString() };
          await this.save(request);
        });
      }
    }
    if (request.status !== "approved") return request;
    if (request.scriptCommand !== await scriptCommand(cwd, argv)) throw new Error("Approved project script changed before execution");
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
      if (permission) {
        const result = permission.mode === "full"
          ? await runFullAccessCommand({ cwd, dataRoot: this.dataRoot, argv, signal })
          : await runSandboxCommand({ cwd, dataRoot: this.dataRoot, roots: permission.roots, argv, signal, network });
        await writeFile(logPath, `command=${JSON.stringify(argv)}\ncwd=${cwd}\nnetwork=${network}\nexit=${result.exitCode}\nsandbox=${permission.mode !== "full"}\n${result.stdout}\n${result.stderr}`, { flag: "wx" });
        request.status = result.timedOut || result.cancelled ? "uncertain" : "complete";
        request.result = { exitCode: result.exitCode, logPath, revision: await fingerprintSource(cwd) };
        await this.save(request);
        return request;
      }
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

export function createCommandTool(store: CommandApprovalStore, taskId: string, cwd: string, permission?: { mode: PermissionMode; roots: string[] }, reviewer?: IndependentReview, onNeedsInput?: (reason: string) => Promise<void>): CustomTool<typeof parameters> {
  return {
    name: "alpha_command",
    label: "Request an approved command",
    description: "Run or request an exact command outside configured checks. Approval follows this task's permission mode; high-risk commands require the user.",
    parameters,
    loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        const result = await store.execute(taskId, cwd, args.argv, args.purpose, signal, permission, reviewer, args.network === true);
        if (result.status === "pending" && !signal?.aborted) await onNeedsInput?.(`Command approval required (${result.risk ?? "normal"}): ${result.argv.join(" ")}. ${result.reason ?? ""}`);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.status !== "complete" || result.result?.exitCode !== 0 };
      } catch (error) {
        if (error instanceof SandboxUnavailableError) await onNeedsInput?.(error.message);
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
