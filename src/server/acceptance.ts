// How a finished model run is accepted, one strategy per acceptance kind (see runtime/task-profile.ts). The run loop
// in runs.ts handles what every task shares (stopping, plan review, pending integration) and then hands over here.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acceptCodeChange } from "../runtime/code-acceptance";
import { verifyGeneralDeliverable } from "../runtime/general-work";
import type { OperationLease } from "../runtime/operation-manager";
import { assertWritablePaths, type ProjectTurn } from "../runtime/project-state";
import { requestedOutput } from "../runtime/requested-output";
import { snapshotSourceHashes, sourceChanges } from "../runtime/source-review";
import { TaskLedger } from "../runtime/task-ledger";
import { taskProfile, type AcceptanceKind } from "../runtime/task-profile";
import type { ServerContext } from "./context";
import { buildProduct, controlledVerification, publishPreview } from "./verification";

export interface AcceptanceRun {
  ctx: ServerContext;
  lease: OperationLease;
  runId: string;
  /** The ledger the model run returned. */
  ledger: TaskLedger;
  projectRoot: string;
  signal: AbortSignal;
  /** Source hashes from before the run, to tell what it changed. */
  beforeHashes: Awaited<ReturnType<typeof snapshotSourceHashes>>;
  projectTurn: ProjectTurn | null;
  emit(message: Record<string, unknown>): void;
  /** Runs the model again on the task with a repair instruction and returns the updated ledger. */
  repair(ledger: TaskLedger, objective: string): Promise<TaskLedger>;
}

type Strategy = (run: AcceptanceRun) => Promise<TaskLedger>;

const STRATEGIES: Record<AcceptanceKind, Strategy> = {
  "web-preview": acceptWebPreview,
  "code-checks": acceptCodeChecks,
  deliverable: acceptDeliverable,
  adaptive: acceptAdaptive,
};

export function acceptRun(run: AcceptanceRun): Promise<TaskLedger> {
  return STRATEGIES[taskProfile(run.ledger.state.taskType).acceptance](run);
}

function accepted(run: AcceptanceRun, ledger: TaskLedger): TaskLedger {
  run.emit({ type: "task", task: run.ctx.taskView(ledger) });
  run.emit({ type: "status", phase: "已验收", runId: run.runId, pending: [] });
  return ledger;
}

/** Build, publish the local preview and verify the core user path in the visible browser, with one repair round. */
async function acceptWebPreview(run: AcceptanceRun): Promise<TaskLedger> {
  const { ctx, runId, projectRoot, signal, emit } = run;
  const ledger = run.ledger;
  emit({ type: "status", phase: "验证构建", runId });
  if (!(await buildProduct(ctx, projectRoot, ledger, signal))) {
    emit({ type: "status", phase: signal.aborted ? "已停止" : "失败", runId, pending: ledger.completionGaps() });
    return ledger;
  }
  emit({ type: "status", phase: "发布本机预览", runId });
  await publishPreview(ctx, ledger, projectRoot);
  for (let attempt = 0; attempt < 2; attempt++) {
    emit({ type: "status", phase: "浏览器验收", runId });
    try {
      await controlledVerification(ctx, await TaskLedger.load(ledger.file), signal, run.lease);
      const verified = await TaskLedger.load(ledger.file);
      emit({ type: "task", task: ctx.taskView(verified) });
      emit({ type: "tool", name: "browser", state: "通过" });
      emit({ type: "status", phase: verified.completionGaps().length ? "待验收" : "已验收", runId, pending: verified.completionGaps() });
      return verified;
    } catch (error) {
      if (ctx.webKernel.controlHolder === "user") {
        emit({ type: "status", phase: "用户接管", runId, pending: (await TaskLedger.load(ledger.file)).completionGaps() });
        return await TaskLedger.load(ledger.file);
      }
      const reason = error instanceof Error ? error.message : String(error);
      emit({ type: "tool", name: "browser", state: `验收失败：${reason.slice(0, 400)}`, error: true });
      const current = await TaskLedger.load(ledger.file);
      if (current.state.status === "active") await current.recordFailure(reason);
      const latestBrowser = current.state.evidence.findLast(item => item.criterionId === "user-path" && item.previewId === current.state.preview?.id);
      if (signal.aborted || attempt === 1 || (latestBrowser?.passed !== false && !reason.includes("Verification plan"))) break;
      emit({ type: "status", phase: "修复中", runId, pending: current.completionGaps() });
      const failedRevision = current.state.revision;
      const repaired = await run.repair(current, `Visible browser acceptance failed: ${reason}. Read the failure evidence and inspect the exact failing step. Decide whether the product or the verification plan is wrong; preserve the original requirements and do not change product code to fix an invalid test selector. Then rebuild.`);
      if (signal.aborted || repaired.state.revision === failedRevision) break;
      emit({ type: "status", phase: "验证构建", runId });
      if (!(await buildProduct(ctx, projectRoot, repaired, signal))) break;
      emit({ type: "status", phase: "发布本机预览", runId });
      await publishPreview(ctx, repaired, projectRoot);
    }
  }
  const current = await TaskLedger.load(ledger.file);
  emit({ type: "status", phase: "待验收", runId, pending: current.completionGaps() });
  return current;
}

/** Configured checks over the source change; with goal continuation a failing check is recorded and retried. */
async function acceptCodeChecks(run: AcceptanceRun): Promise<TaskLedger> {
  const { ledger, runId, emit } = run;
  let passed = false;
  try { passed = await acceptCodeChange({ ledger, dataRoot: run.ctx.dataRoot, runId: ledger.state.goal?.enabled ? randomUUID() : runId, signal: run.signal, complete: false, onCheck: name => emit({ type: "status", phase: `检查 ${name}`, runId }) }); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!ledger.state.goal?.enabled || !reason.startsWith("Configured check failed:")) throw error;
    await ledger.recordFailure(reason);
  }
  if (!passed) {
    emit({ type: "status", phase: "待验收", runId, pending: ledger.completionGaps() });
    return ledger;
  }
  return accepted(run, ledger);
}

/** A reviewable deliverable: listed outputs exist, match their format, and cite archived sources where required. */
async function acceptDeliverable(run: AcceptanceRun): Promise<TaskLedger> {
  const { ledger, runId, emit } = run;
  try { await verifyGeneralDeliverable(ledger, run.ctx.dataRoot, false); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!ledger.state.goal?.enabled || /Input changed|Workspace changed|outside|source unavailable/i.test(reason)) throw error;
    await ledger.recordFailure(reason);
    emit({ type: "status", phase: "待验收", runId, pending: ledger.completionGaps() });
    return ledger;
  }
  return accepted(run, ledger);
}

/**
 * General tasks decide their criteria from what the run produced: a deliverable manifest, a web product with a
 * verification plan, a source change under configured checks, or a plain answer.
 */
async function acceptAdaptive(run: AcceptanceRun): Promise<TaskLedger> {
  const { ctx, ledger, runId, projectRoot, emit } = run;
  const fileChanges = sourceChanges(run.beforeHashes, await snapshotSourceHashes(projectRoot));
  const changed = fileChanges.map(item => item.path);
  const hasManifest = await Bun.file(join(projectRoot, "alpha-deliverable.json")).exists() &&
    (changed.some(path => path === "alpha-deliverable.json" || path.startsWith("outputs/")) || ledger.state.criteria.some(item => item.id === "deliverable"));
  const hasWebPlan = await Bun.file(join(projectRoot, "alpha-verification.json")).exists() &&
    (changed.some(path => path !== "alpha-deliverable.json" && !path.startsWith("outputs/")) || ledger.state.criteria.some(item => item.id === "user-path"));
  const codeChanged = changed.some(path => path !== "alpha-deliverable.json" && path !== "alpha-verification.json" && !path.startsWith("outputs/"));
  const scheduledDocuments = ctx.automationRuns.has(runId) && ledger.state.workspaceOrigin?.kind === "direct" && fileChanges.length > 0 &&
    fileChanges.every(item => item.after !== null && /\.(?:md|txt|png|jpe?g|webp|svg)$/i.test(item.path));
  await ledger.setCriteria([
    ...(hasManifest ? [{ id: "deliverable", description: "交付文件已核查", kind: "artifact" as const }] : []),
    ...(hasWebPlan ? [{ id: "build", description: "产品构建", kind: "build" as const }, { id: "user-path", description: "浏览器关键路径", kind: "browser" as const }] : []),
    ...(!hasWebPlan && codeChanged ? [{ id: "change", description: scheduledDocuments ? "文档变更可审阅" : "源码变更可审阅", kind: "asset" as const }, ...(scheduledDocuments ? [] : [{ id: "check", description: "项目检查通过", kind: "test" as const }])] : []),
  ]);
  if (hasManifest) {
    await verifyGeneralDeliverable(ledger, ctx.dataRoot, false);
    if (!hasWebPlan && !codeChanged) return accepted(run, ledger);
  }
  if (hasWebPlan) {
    if (ledger.state.workspaceOrigin?.kind === "direct") throw new Error("Direct-project web build is unavailable inside the native sandbox");
    return acceptWebPreview(run);
  }
  if (codeChanged) {
    if (scheduledDocuments) {
      if (run.projectTurn) assertWritablePaths(run.projectTurn, changed.map(path => resolve(projectRoot, path)));
      const evidenceRoot = join(ctx.dataRoot, "evidence");
      await mkdir(evidenceRoot, { recursive: true });
      const evidencePath = join(evidenceRoot, `${ledger.state.id}-${runId}-document-changes.json`);
      await writeFile(evidencePath, JSON.stringify({ changes: fileChanges }, null, 2), { flag: "wx" });
      await ledger.recordEvidence({ criterionId: "change", kind: "asset", revision: ledger.state.revision!, passed: true, source: evidencePath });
      emit({ type: "task", task: ctx.taskView(ledger) });
      emit({ type: "status", phase: "文档待审阅", runId, pending: ledger.completionGaps() });
      return ledger;
    }
    const passed = await acceptCodeChange({ ledger, dataRoot: ctx.dataRoot, runId, signal: run.signal, complete: false, onCheck: name => emit({ type: "status", phase: `检查 ${name}`, runId }) });
    emit({ type: "task", task: ctx.taskView(ledger) });
    emit({ type: "status", phase: passed ? "已验收" : "待验收", runId, pending: ledger.completionGaps() });
    return ledger;
  }
  ctx.flushText(ledger.state.id);
  const answer = (await ctx.activityFor(ledger.state.id).read()).filter(item => item.operationId === runId && item.kind === "text" && item.value.trim()).map(item => item.value).join("\n").trim();
  if (!answer) throw new Error("Task returned without an answer or reviewable output");
  const requested = requestedOutput(ledger.state.objective);
  if (requested.deliverable) throw new Error("Requested deliverable is missing");
  if (requested.sourceChange) throw new Error("Requested source change is missing");
  if (requested.webProduct) throw new Error("Requested web product is missing");
  return accepted(run, ledger);
}
