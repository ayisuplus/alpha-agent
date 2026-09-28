import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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

/**
 * The configured check a script argument names. Models often pass the command that runs a check ("bun run test",
 * "npm test", or the script's own command line) instead of its name; those resolve to the named check, which still
 * runs exactly as configured. Anything else is not a configured check.
 */
export function resolveCheckName(script: string, allowed: readonly ConfiguredCheck[]): string | null {
  const value = script.trim();
  if (allowed.some(item => item.name === value)) return value;
  const named = /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)$/.exec(value)?.[1];
  if (named && allowed.some(item => item.name === named)) return named;
  return allowed.find(item => item.command.trim() === value)?.name ?? null;
}

function checkNames(allowed: readonly ConfiguredCheck[]): string {
  return allowed.map(item => item.name).join(", ") || "none configured";
}

export async function runCodeCheck(projectRoot: string, dataRoot: string, taskId: string, requested: string, allowed: ConfiguredCheck[], signal?: AbortSignal, permission?: { mode: PermissionMode; roots: string[] }): Promise<{ passed: boolean; logPath: string; output: string }> {
  const script = resolveCheckName(requested, allowed) ?? requested;
  const approved = allowed.find(item => item.name === script);
  if (!approved || !(await configuredChecks(projectRoot)).some(item => item.name === script && item.command === approved.command)) {
    throw new Error(`Unconfigured or changed command requires workbench approval: ${requested}. Pass a configured check name (${checkNames(allowed)}); other commands go through alpha_command.`);
  }
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
    description: `Run a configured project check by name: ${checkNames(allowed)}. Pass the name, not a shell command; other commands require workbench approval.`,
    parameters,
    loadMode: "essential",
    async execute(_id, args, _update, _ctx, signal) {
      try {
        if (workerRestricted && commandRisk([allowed.find(item => item.name === resolveCheckName(args.script, allowed))?.command ?? ""]) === "high") throw new Error("高风险检查命令须由主代理受控执行；请使用 alpha_capability_request。");
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

/**
 * Read-only checks run in one of a few fixed copy slots. The Windows sandbox keeps one profile per set of writable
 * folders and provisions it on first use, which asks for administrator approval; with fixed slots that happens a few
 * times per machine rather than on every check. Slots are shared by every Alpha process, so a lock guards each one.
 */
const VERIFICATION_SLOTS = 3;
const SLOT_LOCK_STALE_MS = 30 * 60_000;

export function verificationSlotsRoot(dataRoot: string): string {
  if (process.env.ALPHA_VERIFICATION_SLOTS) return resolve(process.env.ALPHA_VERIFICATION_SLOTS);
  return process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Alpha", "verification-slots") : join(resolve(dataRoot), "verification-slots");
}

/** Empties a slot but keeps the folder itself, whose sandbox permissions were granted once. Links are removed, never followed. */
async function clearSlot(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) await unlink(path).catch(() => rm(path, { force: true }));
    else await rm(path, { recursive: true, force: true });
  }
}

async function acquireSlot(base: string, signal?: AbortSignal): Promise<{ root: string; release(): Promise<void> }> {
  await mkdir(base, { recursive: true });
  while (true) {
    for (let index = 0; index < VERIFICATION_SLOTS; index++) {
      const lock = join(base, `slot-${index}.lock`);
      try { await mkdir(lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A lock left by a crashed process is released after the longest a check may run.
        const age = Date.now() - await stat(lock).then(item => item.mtimeMs, () => Date.now());
        if (age > SLOT_LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
        continue;
      }
      const root = join(base, `slot-${index}`);
      try {
        await mkdir(root, { recursive: true });
        await clearSlot(root);
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      return {
        root,
        async release() {
          try { await clearSlot(root); }
          finally { await rm(lock, { recursive: true, force: true }); }
        },
      };
    }
    signal?.throwIfAborted();
    await Bun.sleep(500);
  }
}

export function createReadOnlyCodeCheckTool(projectRoot: string, dataRoot: string, taskId: string, allowed: ConfiguredCheck[]): CustomTool<typeof parameters> {
  let sandboxUnavailable: string | null = null;
  return {
    name: "alpha_check", label: "Check a verification copy", loadMode: "essential", parameters,
    description: `Run a configured check by name (${checkNames(allowed)}) in a sandboxed temporary copy of the source, which stays read-only. Pass the name, not a shell command.`,
    async execute(_id, args, _update, _ctx, signal) {
      if (sandboxUnavailable) return { content: [{ type: "text", text: sandboxUnavailable }], isError: true };
      let slot: Awaited<ReturnType<typeof acquireSlot>> | undefined;
      try {
        slot = await acquireSlot(verificationSlotsRoot(dataRoot), signal);
        const copyRoot = slot.root;
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
        const reason = error instanceof Error ? error.message : String(error);
        // Retrying cannot help when the sandbox itself is unavailable; say what to do instead and stop probing.
        if (error instanceof SandboxUnavailableError) {
          sandboxUnavailable = `Checks cannot run in this environment: ${reason}. Do not call alpha_check again in this session. Review the source directly and submit your result, stating that checks could not run and why.`;
          return { content: [{ type: "text", text: sandboxUnavailable }], isError: true };
        }
        return { content: [{ type: "text", text: reason }], isError: true };
      } finally {
        await slot?.release();
      }
    },
  };
}
