// Building a web product, publishing its local preview and verifying it in the one visible browser. Used by model
// runs (through acceptance) and by the publish and verify routes.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyBrowserPlan } from "../runtime/browser-verifier";
import { buildChildEnv } from "../runtime/child-env";
import { publishLocalPreview, type PreviewInstance } from "../runtime/local-preview";
import { assertGeneratedAssetsIntact } from "../runtime/media-integrity";
import type { OperationLease } from "../runtime/operation-manager";
import type { TaskLedger } from "../runtime/task-ledger";
import type { ServerContext } from "./context";

export async function buildProduct(ctx: ServerContext, projectRoot: string, ledger: TaskLedger, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  await assertGeneratedAssetsIntact(projectRoot, ctx.dataRoot);
  const child = Bun.spawn([process.execPath, "run", "build"], { cwd: projectRoot, env: buildChildEnv(), stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const log = `command=${process.execPath} run build\ncwd=${projectRoot}\nexit=${exitCode}\n${stdout}\n${stderr}`;
    const logPath = join(ctx.dataRoot, "build-logs", `${ledger.state.id}-${randomUUID()}.log`);
    await mkdir(join(ctx.dataRoot, "build-logs"), { recursive: true });
    await writeFile(logPath, log);
    ctx.emit({ type: "tool", taskId: ledger.state.id, name: "build", state: exitCode === 0 ? "通过" : "失败", error: exitCode !== 0 });
    if (exitCode !== 0 || signal.aborted) return false;
    await assertGeneratedAssetsIntact(projectRoot, ctx.dataRoot);
    await ledger.recordEvidence({ criterionId: "build", kind: "build", passed: true, revision: ledger.state.revision!, source: logPath });
    return true;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
export async function publishPreview(ctx: ServerContext, ledger: TaskLedger, projectRoot: string): Promise<PreviewInstance> {
  const previousId = ledger.state.preview?.id;
  const instance = await publishLocalPreview({ projectRoot, buildDir: join(projectRoot, "dist"), dataRoot: ctx.dataRoot, revision: ledger.state.revision!, taskId: ledger.state.id });
  try {
    await ledger.recordPreview(instance.record);
  } catch (error) {
    instance.stop();
    throw error;
  }
  ctx.previews.set(instance.record.id, instance);
  if (previousId) {
    ctx.previews.get(previousId)?.stop();
    ctx.previews.delete(previousId);
  }
  ctx.setContext(ledger);
  ctx.emit({ type: "preview", taskId: ledger.state.id, url: instance.record.url, previewId: instance.record.id, pending: ledger.completionGaps() });
  return instance;
}

async function verifyTaskBrowser(ctx: ServerContext, ledger: TaskLedger, signal: AbortSignal): Promise<void> {
  const cdpPort = process.env.ALPHA_CDP_PORT;
  if (!cdpPort || !/^\d+$/.test(cdpPort)) throw new Error("Desktop browser debugging port is unavailable");
  if (await Bun.file(join(ledger.state.projectRoot, "alpha-verification.json")).exists()) {
    await verifyBrowserPlan(ledger, Number(cdpPort), ctx.dataRoot, signal, ctx.webKernel, false);
    return;
  }
  if (!/素材清单|inventory/i.test(ledger.state.objective)) throw new Error("Verification plan is missing: alpha-verification.json");
  const child = Bun.spawn([process.execPath, "run", "scripts/verify-inventory.ts", ledger.file, cdpPort], { cwd: ctx.appRoot, stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (signal.aborted) throw new Error("Verification stopped");
    if (exitCode !== 0) throw new Error(stderr.trim().slice(-2_000) || stdout.trim().slice(-2_000) || "Browser verification failed");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Browser acceptance in the one visible preview; concurrent tasks wait their turn. */
export async function controlledVerification(ctx: ServerContext, ledger: TaskLedger, signal: AbortSignal, lease: OperationLease): Promise<void> {
  if (ctx.webKernel.controlHolder !== "alpha") throw new Error("User controls the visible browser");
  ctx.operations.update(lease, { phase: "等待浏览器" });
  const release = await ctx.browserLock.acquire(lease.id, signal);
  const controller = new AbortController();
  ctx.verifications.set(ledger.state.id, controller);
  ctx.operations.update(lease, { browserTaskId: ledger.state.id, phase: "浏览器验收" });
  try {
    if (ctx.webKernel.controlHolder !== "alpha") throw new Error("User controls the visible browser");
    await verifyTaskBrowser(ctx, ledger, AbortSignal.any([signal, controller.signal]));
  } finally {
    if (ctx.verifications.get(ledger.state.id) === controller) ctx.verifications.delete(ledger.state.id);
    ctx.operations.update(lease, { browserTaskId: null });
    release();
  }
}
