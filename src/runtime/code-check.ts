import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { buildChildEnv } from "./child-env";
import { commandApprovalStore, commandRisk } from "./command-approval";
import { runFullAccessCommand, runSandboxCommand, SandboxUnavailableError } from "./sandbox-exec";
import { fingerprintSource, type PermissionMode } from "./task-ledger";

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

export function createCodeCheckTool(projectRoot: string, dataRoot: string, taskId: string, allowed: ConfiguredCheck[], permission?: { mode: PermissionMode; roots: string[] }, onNeedsInput?: (reason: string) => Promise<void>): CustomTool<typeof parameters> {
  return {
    name: "alpha_check",
    label: "Run configured project check",
    description: "Run one of the project's existing package scripts named check, typecheck, lint or test. Other commands require workbench approval.",
    parameters,
    loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        const result = await runCodeCheck(projectRoot, dataRoot, taskId, args.script, allowed, signal, permission);
        return { content: [{ type: "text", text: `${result.output}\nlog=${result.logPath}` }], isError: !result.passed };
      } catch (error) {
        if (error instanceof SandboxUnavailableError) await onNeedsInput?.(error.message);
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
