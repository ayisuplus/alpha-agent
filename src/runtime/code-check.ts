import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { buildChildEnv } from "./child-env";
import { commandApprovalStore, commandRisk } from "./command-approval";
import { runFullAccessCommand, runSandboxCommand, SandboxUnavailableError } from "./sandbox-exec";
import { fingerprintSource, type PermissionMode } from "./task-ledger";
import { sourceFiles } from "./work-orders";

const parameters = type({ script: "string" });
const CHECK_NAMES = ["check", "typecheck", "lint", "test"];
export interface ConfiguredCheck { name: string; command: string }

export async function configuredChecks(projectRoot: string): Promise<ConfiguredCheck[]> {
  const file = await readFile(join(projectRoot, "package.json"), "utf8").catch(() => null);
  if (!file) return [];
  const parsed = JSON.parse(file) as { scripts?: Record<string, unknown> };
  const names = typeof parsed.scripts?.check === "string" ? ["check"] : CHECK_NAMES.slice(1);
  return names.flatMap(name => typeof parsed.scripts?.[name] === "string" ? [{ name, command: parsed.scripts[name] as string }] : []);
}

export async function runCodeCheck(projectRoot: string, dataRoot: string, taskId: string, script: string, allowed: ConfiguredCheck[], signal?: AbortSignal, permission?: { mode: PermissionMode; roots: string[] }): Promise<{ passed: boolean; logPath: string; output: string }> {
  const approved = allowed.find(item => item.name === script);
  if (!approved || !(await configuredChecks(projectRoot)).some(item => item.name === script && item.command === approved.command)) throw new Error(`Unconfigured or changed command requires workbench approval: ${script}`);
  signal?.throwIfAborted();
  const command = [process.execPath, "run", script];
  if (permission && commandRisk([approved.command]) === "high") {
    const revision = await fingerprintSource(projectRoot);
    const receipt = (await commandApprovalStore(dataRoot).list(taskId)).findLast(item => item.purpose === "check" && item.status === "complete" && item.result?.exitCode === 0
      && item.result.revision === revision && item.scriptCommand === approved.command && JSON.stringify(item.argv) === JSON.stringify(command));
    if (!receipt?.result) throw new Error(`Configured check '${script}' has a high-risk script; request exact-argv user approval through alpha_command`);
    return { passed: true, logPath: receipt.result.logPath, output: `Approved high-risk check receipt: ${receipt.id}\nlog=${receipt.result.logPath}` };
  }
  if (permission) {
    const result = permission.mode === "full"
      ? await runFullAccessCommand({ cwd: projectRoot, dataRoot, argv: command, signal })
      : await runSandboxCommand({ cwd: projectRoot, dataRoot, roots: permission.roots, argv: command, signal });
    const output = `command=${command.join(" ")}\ncwd=${projectRoot}\nexit=${result.exitCode}\nsandbox=${permission.mode !== "full"}\n${result.stdout}\n${result.stderr}`;
    const directory = join(dataRoot, "check-logs");
    await mkdir(directory, { recursive: true });
    const logPath = join(directory, `${taskId}-${randomUUID()}.log`);
    await writeFile(logPath, output, { flag: "wx" });
    return { passed: result.exitCode === 0 && !result.timedOut && !result.cancelled, logPath, output: output.slice(-6_000) };
  }
  const child = Bun.spawn(command, { cwd: projectRoot, env: buildChildEnv(), stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = `command=${command.join(" ")}\ncwd=${projectRoot}\nexit=${exitCode}\n${stdout}\n${stderr}`;
    const directory = join(dataRoot, "check-logs");
    await mkdir(directory, { recursive: true });
    const logPath = join(directory, `${taskId}-${randomUUID()}.log`);
    await writeFile(logPath, output, { flag: "wx" });
    return { passed: exitCode === 0 && !signal?.aborted, logPath, output: output.slice(-6_000) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createCodeCheckTool(projectRoot: string, dataRoot: string, taskId: string, allowed: ConfiguredCheck[], permission?: { mode: PermissionMode; roots: string[] }, onNeedsInput?: (reason: string) => Promise<void>, workerRestricted = false, onReceipt?: (result: { passed: boolean; logPath: string; sourceRevision: string | null }) => Promise<string>): CustomTool<typeof parameters> {
  return {
    name: "alpha_check",
    label: "Run configured project check",
    description: "Run one of the project's existing package scripts named check, typecheck, lint or test. Other commands require workbench approval.",
    parameters,
    loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        if (workerRestricted && commandRisk([allowed.find(item => item.name === args.script)?.command ?? ""]) === "high") throw new Error("高风险检查命令须由主代理受控执行；请使用 alpha_capability_request。");
        const before = onReceipt ? await fingerprintSource(projectRoot) : null;
        const result = await runCodeCheck(projectRoot, dataRoot, taskId, args.script, allowed, signal, permission);
        const changed = onReceipt ? before !== await fingerprintSource(projectRoot) : false;
        const passed = result.passed && !changed;
        const receipt = onReceipt ? await onReceipt({ passed, logPath: result.logPath, sourceRevision: before }) : null;
        return { content: [{ type: "text", text: `${result.output}\nlog=${result.logPath}${receipt ? `\nreceipt=${receipt}` : ""}${changed ? "\nSource changed during check; this result cannot verify the original revision." : ""}` }], isError: !passed };
      } catch (error) {
        if (error instanceof SandboxUnavailableError) await onNeedsInput?.(error.message);
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}

export function createReadOnlyCodeCheckTool(projectRoot: string, dataRoot: string, taskId: string, allowed: ConfiguredCheck[]): CustomTool<typeof parameters> {
  return {
    name: "alpha_check", label: "Check a verification copy", loadMode: "essential", parameters,
    description: "Run a configured check in a sandboxed temporary source copy. The subagent's source remains read-only.",
    async execute(_id, args, _update, _ctx, signal) {
      const base = join(dataRoot, "verification-copies");
      let copyRoot: string | undefined;
      try {
        await mkdir(base, { recursive: true });
        copyRoot = await mkdtemp(join(base, `${taskId}-`));
        const sourceRevision = await fingerprintSource(projectRoot);
        for (const file of await sourceFiles(projectRoot)) {
          const destination = join(copyRoot, file);
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(join(projectRoot, file), destination);
        }
        if (await stat(join(projectRoot, "node_modules")).then(item => item.isDirectory(), () => false)) await symlink(join(projectRoot, "node_modules"), join(copyRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
        const copyRevision = await fingerprintSource(copyRoot);
        const result = await runCodeCheck(copyRoot, dataRoot, taskId, args.script, allowed, signal, { mode: "ask", roots: [copyRoot] });
        const changed = copyRevision !== await fingerprintSource(copyRoot) || sourceRevision !== await fingerprintSource(projectRoot);
        return { content: [{ type: "text", text: `${result.output}\nlog=${result.logPath}\nsourceRevision=${sourceRevision}${changed ? "\nSource changed during verification; check is not valid." : ""}` }], isError: !result.passed || changed };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      } finally {
        if (copyRoot && dirname(resolve(copyRoot)) === resolve(base)) await rm(copyRoot, { recursive: true, force: true });
      }
    },
  };
}
