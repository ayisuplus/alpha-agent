import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { buildChildEnv } from "./child-env";

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

export async function runCodeCheck(projectRoot: string, dataRoot: string, taskId: string, script: string, allowed: ConfiguredCheck[], signal?: AbortSignal): Promise<{ passed: boolean; logPath: string; output: string }> {
  const approved = allowed.find(item => item.name === script);
  if (!approved || !(await configuredChecks(projectRoot)).some(item => item.name === script && item.command === approved.command)) throw new Error(`Unconfigured or changed command requires workbench approval: ${script}`);
  signal?.throwIfAborted();
  const command = [process.execPath, "run", script];
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

export function createCodeCheckTool(projectRoot: string, dataRoot: string, taskId: string, allowed: ConfiguredCheck[]): CustomTool<typeof parameters> {
  return {
    name: "alpha_check",
    label: "Run configured project check",
    description: "Run one of the project's existing package scripts named check, typecheck, lint or test. Other commands require workbench approval.",
    parameters,
    loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        const result = await runCodeCheck(projectRoot, dataRoot, taskId, args.script, allowed, signal);
        return { content: [{ type: "text", text: `${result.output}\nlog=${result.logPath}` }], isError: !result.passed };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
