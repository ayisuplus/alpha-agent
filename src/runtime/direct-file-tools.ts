import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { editInspect } from "@oh-my-pi/pi-natives";
import { commandApprovalStore } from "./command-approval";
import { ProjectStore } from "./projects";
import { protectedSandboxHome, runFullAccessCommand, runSandboxCommand, SandboxUnavailableError } from "./sandbox-exec";
import { fingerprintSource, type PermissionMode } from "./task-ledger";

const workerSource = await readFile(new URL("./sandbox-file-worker.ts", import.meta.url), "utf8");
const readParams = type({ path: "string", "offset?": "number", "limit?": "number" });
const grepParams = type({ pattern: "string", "path?": "string", "case?": "boolean" });
const editParams = type({ input: "string" });
const writeParams = type({ path: "string", content: "string" });
type Action = "read" | "grep" | "edit" | "write";

export interface DirectFileContext {
  taskId: string;
  projectId: string;
  projectVersion: number;
  projectRoot: string;
  dataRoot: string;
  mode: PermissionMode;
  onNeedsInput: (reason: string) => Promise<void>;
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function credential(path: string): boolean {
  return /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.codex|\.npmrc|\.env(?:\.[^\\/]*)?|credentials?(?:\.[^\\/]*)?|id_(?:rsa|ed25519)|auth\.json|user data)(?:[\\/]|$)/i.test(path);
}

export async function createDirectFileTools(context: DirectFileContext): Promise<CustomTool[]> {
  const store = new ProjectStore(context.dataRoot);
  const initialRoots = await store.roots(context.projectId, context.projectVersion);
  const home = protectedSandboxHome({ roots: initialRoots, dataRoot: context.dataRoot });
  await mkdir(home, { recursive: true });
  const worker = join(home, "alpha-file-worker.ts");
  await writeFile(worker, workerSource);
  const nativePath = resolve(import.meta.dir, "../..", "node_modules", "@oh-my-pi", "pi-natives", "native", "index.js");
  const approvals = commandApprovalStore(context.dataRoot);

  const invoke = async (action: Action, args: Record<string, unknown>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const roots = await store.roots(context.projectId, context.projectVersion);
    const inspection = action === "edit" ? editInspect("hashline", JSON.stringify(args)) : null;
    const rawTargets = action === "edit"
      ? [...(inspection?.paths ?? []), ...(inspection?.fileOps.flatMap(item => item.to ? [item.to] : []) ?? [])]
      : [typeof args.path === "string" ? args.path : "."];
    if (!rawTargets.length || rawTargets.some(path => typeof path !== "string" || !path)) throw new Error("File tool targets cannot be inspected");
    const targets = rawTargets.map(path => resolve(context.projectRoot, path));
    const write = action === "edit" || action === "write";
    const outside = write && targets.some(path => !roots.some(root => inside(root, path)));
    const protectedRead = targets.some(credential);
    const destructive = action === "edit" && (inspection?.fileOps.length ?? 0) > 0;
    const systemTarget = targets.some(path => /^[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata)(?:[\\/]|$)/i.test(path));
    const applicationRoot = resolve(import.meta.dir, "../..");
    const metadataTarget = write && targets.some(path => /[\\/]\.(?:git|alpha)(?:[\\/]|$)/i.test(path) || inside(context.dataRoot, path) || inside(applicationRoot, path));
    const approvalNeeded = protectedRead || (outside && context.mode !== "full") || destructive || (context.mode === "full" && systemTarget && write) || metadataTarget;
    let approvalId: string | undefined;
    if (approvalNeeded) {
      const exact = { tool: action, targets, arguments: args, digest: createHash("sha256").update(JSON.stringify({ action, args, targets, roots, mode: context.mode })).digest("hex") };
      if (JSON.stringify(exact).length > 100_000) throw new Error("Approval payload is too large to review safely");
      const reason = protectedRead ? "Known credential location" : metadataTarget ? "Protected application or project metadata" : outside ? "Write outside mounted folders" : destructive ? "Delete or move operation" : "System directory write";
      const approval = await approvals.requestAction(context.taskId, context.projectRoot, exact, reason);
      if (approval.status === "pending") {
        if (!signal?.aborted) await context.onNeedsInput(`${reason}: review exact action ${approval.id} in the workbench`);
        return { content: [{ type: "text" as const, text: `Approval required: ${approval.id}` }], isError: true };
      }
      if (approval.status !== "approved") return { content: [{ type: "text" as const, text: `Action ${approval.status}: ${approval.id}` }], isError: true };
      signal?.throwIfAborted();
      await approvals.claimAction(context.taskId, approval.id);
      approvalId = approval.id;
    }
    const approvedHostAction = !!approvalId && (outside || protectedRead);
    const request = JSON.stringify({ action, args, cwd: context.projectRoot, roots, full: context.mode === "full" || approvedHostAction, allowCredential: protectedRead && !!approvalId, allowMetadata: metadataTarget && !!approvalId, nativePath });
    const command = { cwd: context.projectRoot, roots, dataRoot: context.dataRoot, argv: [process.execPath, worker], stdin: request, signal, timeoutMs: 45_000 };
    try {
      const result = context.mode === "full" || approvedHostAction ? await runFullAccessCommand(command) : await runSandboxCommand(command);
      const marker = "__ALPHA_FILE_RESULT__";
      const line = result.stdout.split(/\r?\n/).findLast(item => item.startsWith(marker));
      if (!line) throw new SandboxUnavailableError(`Sandboxed file worker did not return a result: ${(result.stderr || result.stdout).slice(-600)}`);
      const output = JSON.parse(line.slice(marker.length)) as { text?: string; error?: string };
      if (result.timedOut || result.cancelled) throw new Error("File worker stopped before completion");
      const failed = !!output.error || result.exitCode !== 0;
      if (approvalId) await approvals.finishAction(context.taskId, approvalId, !failed, await fingerprintSource(context.projectRoot));
      return { content: [{ type: "text" as const, text: output.error ?? output.text ?? "" }], isError: failed };
    } catch (error) {
      if (approvalId) await approvals.finishAction(context.taskId, approvalId, false, await fingerprintSource(context.projectRoot));
      throw error;
    }
  };
  const wrapped = <T extends typeof readParams | typeof grepParams | typeof editParams | typeof writeParams>(name: Action, parameters: T, description: string): CustomTool<T> => ({
    name, label: name, description: `Alpha sandbox proxy. ${description}`, parameters, loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try { return await invoke(name, args as Record<string, unknown>, signal); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof SandboxUnavailableError || reason.includes("Project mounts changed")) await context.onNeedsInput(reason);
        return { content: [{ type: "text", text: reason }], isError: true };
      }
    },
  });
  return [
    wrapped("read", readParams, "Read a local text file with Hashline line numbers. Known credential locations need separate user approval."),
    wrapped("grep", grepParams, "Search files in mounted folders, or one explicit file outside them."),
    wrapped("edit", editParams, "Apply an OMP Hashline patch to mounted files. Use current read tags."),
    wrapped("write", writeParams, "Create a new file in a mounted folder. Existing files require Hashline edit."),
  ];
}
