import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runTask, type RunEvent, type RunOptions } from "../runtime/omp-runner";
import { runDevelopmentWorkflow } from "../runtime/development-workflow";
import { isModelAvailable } from "../runtime/models";
import { TaskLedger } from "../runtime/task-ledger";
import { goalStopReason, nextGoalCycle, progressSignature } from "../runtime/goal-continuation";
import { snapshotSource, snapshotSourceHashes, writeSourceReview } from "../runtime/source-review";
import type { ClaimOptions, OperationKind, OperationLease } from "../runtime/operation-manager";
import { createGeneralWorkspace } from "../runtime/general-work";
import { scopedGitBackup } from "../runtime/scoped-git-backup";
import { bindProjectTurn, finalizeProjectTurn, mayWriteProject, prepareProjectTurn, type ProjectTurn } from "../runtime/project-state";
import { configuredChecks } from "../runtime/code-check";
import { SandboxUnavailableError, verifySandbox } from "../runtime/sandbox-exec";
import { acceptRun } from "./acceptance";
import type { RunState, ServerContext } from "./context";

export type Launch = { startMode: "plan" | "execute"; continueUntilAccepted: boolean };

const REFUSALS = {
  exclusive: "正在清理预览，请稍后再试",
  task: "这个任务正在运行，请等它结束或先停止",
  folder: "同一文件夹中的另一个任务正在运行，请等它结束",
  project: "这个项目有任务正在运行，结束后才能更改挂载目录",
} as const;

/**
 * Claims an operation; tasks run side by side up to the configured limit. Returns the lease, or the refusal to send
 * back (409) naming what is in the way.
 */
export async function claim(ctx: ServerContext, kind: OperationKind, options: ClaimOptions): Promise<OperationLease | Response> {
  const limit = (await ctx.settingsStore.get()).budget.maxParallelTasks;
  const scoped = { ...options, runLimit: limit };
  const lease = ctx.operations.claim(kind, scoped);
  if (lease) return lease;
  const reason = ctx.operations.conflict(kind, scoped);
  const message = reason === "limit" || reason === null ? `同时运行的任务已达上限（${limit} 个），请等其他任务结束，或在「设置 → 运行」中调高` : REFUSALS[reason];
  return Response.json({ error: message }, { status: 409 });
}

/** Claim options covering a task's own workspace. */
export function taskScope(ledger: TaskLedger): ClaimOptions {
  return { taskId: ledger.state.id, projectId: ledger.state.projectId ?? null, roots: [ledger.state.projectRoot] };
}

function publishRuns(ctx: ServerContext): void {
  ctx.broadcast({ type: "runs", runs: [...ctx.runs.values()].map(run => ({ runId: run.runId, taskId: run.taskId, kind: run.kind })) });
}

export function registerRun(ctx: ServerContext, lease: OperationLease, kind: RunState["kind"], ledger?: TaskLedger, runId: string = randomUUID()): RunState {
  const run: RunState = { runId, kind, lease, taskId: ledger?.state.id ?? null, ledger, steeringIds: new Set() };
  ctx.runs.set(runId, run);
  if (ledger) {
    ctx.setContext(ledger);
    ctx.operationIds.set(ledger.state.id, runId);
    ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
  }
  publishRuns(ctx);
  return run;
}

async function endRun(ctx: ServerContext, run: RunState): Promise<void> {
  ctx.runs.delete(run.runId);
  ctx.operations.release(run.lease);
  publishRuns(ctx);
  if (run.taskId) {
    const final = await ctx.loadLedger(run.taskId);
    if (final) ctx.emit({ type: "task", taskId: final.state.id, task: ctx.taskView(final) });
  }
  void drainQueue(ctx);
  void drainAutomations(ctx);
}

/** Registers a model run for a claimed lease and starts it in the background. */
export function launch(ctx: ServerContext, lease: OperationLease, ledger: TaskLedger | undefined, objective: string, projectRoot: string, extra: { newTaskModel?: string; designatedExpertId?: string; launch?: Launch; runId?: string } = {}): RunState {
  const run = registerRun(ctx, lease, "run", ledger, extra.runId);
  void execute(ctx, run, objective, projectRoot, ledger, extra.newTaskModel, extra.designatedExpertId, extra.launch);
  return run;
}

export async function deliverGuidance(ctx: ServerContext, run: RunState, ledger: TaskLedger, id: string, instruction: string): Promise<void> {
  if (!run.steer || run.steeringIds.has(id)) return;
  run.steeringIds.add(id);
  try {
    await run.steer(instruction);
    await ledger.setGuidanceStatus(id, "delivered");
    ctx.appendActivity(ledger.state.id, "guidance", "补充要求已投递到当前模型会话");
  } finally {
    run.steeringIds.delete(id);
  }
}

function sessionHooks(ctx: ServerContext, run: RunState) {
  return {
    async onSessionReady(steer: (text: string) => Promise<void>) {
      if (!run.ledger) return;
      run.steer = steer;
      ctx.emit({ type: "task", taskId: run.ledger.state.id, task: ctx.taskView(run.ledger) });
      for (const item of run.ledger.state.guidanceHistory ?? []) {
        if (item.id && item.status === "recorded") await run.ledger.setGuidanceStatus(item.id, "delivered");
      }
    },
    async onSessionEnd(queued: readonly string[], completed: boolean) {
      if (!run.ledger) return;
      run.steer = undefined;
      if (completed) {
        for (const item of run.ledger.state.guidanceHistory ?? []) {
          if (item.id && item.status === "delivered" && !queued.includes(item.instruction)) await run.ledger.setGuidanceStatus(item.id, "processed");
        }
      }
      ctx.emit({ type: "task", taskId: run.ledger.state.id, task: ctx.taskView(run.ledger) });
    },
  };
}

async function execute(ctx: ServerContext, run: RunState, objective: string, projectRoot: string, existingLedger?: TaskLedger, newTaskModel?: string, designatedExpertId?: string, launchOptions: Launch = { startMode: "execute", continueUntilAccepted: false }): Promise<void> {
  const { runId, lease } = run;
  const controller = lease.controller;
  const { dataRoot, webKernel } = ctx;
  let beforeSource: Awaited<ReturnType<typeof snapshotSource>> | null = null;
  let beforeHashes: Awaited<ReturnType<typeof snapshotSourceHashes>> | null = null;
  let runError: string | null = null;
  let projectTurn: ProjectTurn | null = null;
  let writingToolObserved = false;
  const emitRun = (message: Record<string, unknown>) => ctx.emit({ ...message, taskId: run.ledger?.state.id ?? existingLedger?.state.id });
  // The visible browser serves one operation at a time; a model run uses it only while no verification holds it.
  const browserFree = () => webKernel.controlHolder === "alpha" && (ctx.browserLock.owner === null || ctx.browserLock.owner === lease.id);
  const modelRun = async (options: RunOptions): Promise<TaskLedger> => {
    const preview = options.existingLedger?.state.preview;
    const port = process.env.ALPHA_CDP_PORT;
    const browser = options.existingLedger?.state.workspaceOrigin?.kind !== "direct" && preview && ctx.previews.has(preview.id) && browserFree() && port && /^\d+$/.test(port)
      ? await webKernel.connectPreview(options.existingLedger!.state.id, preview.url, controller.signal).catch(() => undefined)
      : undefined;
    if (browser && options.existingLedger) ctx.operations.update(lease, { browserTaskId: options.existingLedger.state.id });
    try {
      return await runDevelopmentWorkflow({ ...options, browser, webKernel, browserUrl: preview?.url, browserAccess: browserFree });
    } finally {
      if (browser && options.existingLedger) await webKernel.detachPreview(options.existingLedger.state.id);
      ctx.operations.update(lease, { browserTaskId: null });
    }
  };
  try {
    if (existingLedger?.state.projectId) {
      try { await ctx.projectStore.roots(existingLedger.state.projectId, existingLedger.state.projectVersion ?? 0); }
      catch (error) {
        if (existingLedger.state.status === "active") await existingLedger.needInput(`项目目录已变化，需要重新检查：${error instanceof Error ? error.message : String(error)}`, "project");
        throw error;
      }
    }
    if (existingLedger?.state.workspaceOrigin?.kind === "direct" && existingLedger.state.projectId) {
      const roots = await ctx.projectStore.roots(existingLedger.state.projectId, existingLedger.state.projectVersion ?? 0);
      await verifySandbox({ cwd: projectRoot, roots, dataRoot, network: existingLedger.state.permissionMode === "full", signal: controller.signal });
    }
    projectTurn = await prepareProjectTurn({ dataRoot, projectRoot, runId, ledger: existingLedger });
    const configured = await ctx.configuredRun(existingLedger?.state.modelSelector ?? newTaskModel, existingLedger);
    if (existingLedger?.state.goal?.enabled && !existingLedger.state.goal.budget) await existingLedger.setGoal(true, { maxToolCalls: configured.maxToolCalls, wallTimeMs: configured.wallTimeMs, maxTotalToolCalls: configured.maxTotalToolCalls, totalWallTimeMs: configured.totalWallTimeMs });
    else if (existingLedger?.state.goal?.enabled && existingLedger.state.goal.stopReason) await existingLedger.setGoalProgress(0);
    beforeSource = await snapshotSource(projectRoot);
    beforeHashes = await snapshotSourceHashes(projectRoot);
    emitRun({ type: "status", phase: "构建中", runId });
    const forwardEvent = (event: RunEvent) => {
      if (event.type === "tool-start" && mayWriteProject(event.value)) writingToolObserved = true;
      if (event.type === "text") emitRun({ type: "text", value: event.value });
      else if (event.type === "status") emitRun({ type: "status", phase: event.value, runId });
      else emitRun({ type: "tool", name: event.value, state: event.type === "tool-start" ? "开始" : "结束", error: event.error, callId: event.callId, target: event.target, intent: event.intent });
    };
    let currentLedger = existingLedger;
    let currentInstruction = objective;
    while (true) {
      const beforeProgress = currentLedger ? progressSignature(currentLedger) : null;
      const cycleOptions = currentLedger ? await ctx.configuredRun(currentLedger.state.modelSelector, currentLedger) : configured;
      const ledger = await modelRun({
        ...cycleOptions,
        taskModel: newTaskModel,
        designatedExpertId,
        startMode: launchOptions.startMode,
        continueUntilAccepted: launchOptions.continueUntilAccepted,
        projectRoot, objective: currentInstruction, dataRoot, signal: controller.signal, existingLedger: currentLedger,
        onNeedsInput: reason => controller.abort(new Error(reason)),
        onEvent: forwardEvent,
        onWorkerState: changed => emitRun({ type: "task", task: ctx.taskView(changed) }),
        async onLedger(created) {
          if (projectTurn) await bindProjectTurn(projectTurn, created);
          await ctx.operationJournal.start(created.state.id, runId);
          run.ledger = created;
          run.taskId = created.state.id;
          if (!ctx.operations.forTask(created.state.id)) ctx.operations.bind(lease, { taskId: created.state.id, projectId: created.state.projectId ?? null });
          publishRuns(ctx);
          ctx.setContext(created);
          ctx.operationIds.set(created.state.id, runId);
          if (!currentLedger) {
            ctx.appendActivity(created.state.id, "status", "任务已创建", runId);
            ctx.nameTask(created);
          }
          emitRun({ type: "task", task: ctx.taskView(created) });
        },
        ...sessionHooks(ctx, run),
      });
      const verifyCycle = async (): Promise<TaskLedger> => {
        run.ledger = ledger;
        emitRun({ type: "task", task: ctx.taskView(ledger) });
        if (controller.signal.aborted) {
          emitRun({ type: "status", phase: "已停止", runId, pending: ledger.completionGaps() });
          return ledger;
        }
        if (ledger.state.phase === "plan") {
          try { await ledger.submitPlanForReview(); emitRun({ type: "status", phase: "计划待审阅", runId }); }
          catch (error) { await ledger.recordFailure(error instanceof Error ? error.message : String(error)); emitRun({ type: "status", phase: "继续规划", runId }); }
          emitRun({ type: "task", task: ctx.taskView(ledger) });
          return ledger;
        }
        if (ledger.state.phase === "plan-review") {
          emitRun({ type: "status", phase: "计划待审阅", runId });
          return ledger;
        }
        if (ledger.state.status !== "active" || ledger.completionGaps().includes("worker-integration")) {
          emitRun({ type: "status", phase: ledger.state.status === "needs-input" ? "需要回答" : "子实例待集成", runId, pending: ledger.completionGaps() });
          return ledger;
        }
        return await acceptRun({
          ctx, lease, runId, ledger, projectRoot, signal: controller.signal, beforeHashes: beforeHashes ?? {}, projectTurn, emit: emitRun,
          repair: async (current, instruction) => modelRun({
            ...await ctx.configuredRun(current.state.modelSelector, current),
            projectRoot, dataRoot, signal: controller.signal, existingLedger: current, objective: instruction,
            onEvent: forwardEvent,
            async onLedger(created) { await ctx.operationJournal.start(created.state.id, runId); run.ledger = created; ctx.setContext(created); },
            ...sessionHooks(ctx, run),
          }),
        });
      };
      const verified = await verifyCycle();
      currentLedger = await TaskLedger.load(verified.file);
      const continuation = nextGoalCycle(currentLedger, beforeProgress, controller.signal.aborted, webKernel.controlHolder === "user");
      if (!continuation.continue && continuation.stopReason !== "no-progress") return;
      if (continuation.stopReason === "no-progress") {
        await currentLedger.recordFailure("Two consecutive goal cycles made no source, deliverable, or verified-evidence progress");
        await currentLedger.setGoalProgress(continuation.noProgressRuns, "no-progress");
        await currentLedger.stop();
        emitRun({ type: "task", task: ctx.taskView(currentLedger) });
        emitRun({ type: "status", phase: "无实际进展，已停止", runId, pending: currentLedger.completionGaps() });
        return;
      }
      await currentLedger.setGoalProgress(continuation.noProgressRuns);
      currentInstruction = `Continue the current task toward acceptance. Inspect the latest failed checks and evidence, choose the next justified action, and stop to ask for input if blocked. Pending: ${currentLedger.completionGaps().join(", ")}.`;
      emitRun({ type: "status", phase: "目标继续推进", runId, pending: currentLedger.completionGaps() });
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    const current = run.ledger ? await TaskLedger.load(run.ledger.file).catch(() => null) : null;
    if (current) {
      if (current.state.status === "active") {
        if (error instanceof SandboxUnavailableError) await current.needInput(error.message, "windows-sandbox");
        else if (/^Authenticated model is unavailable:/.test(runError)) await current.needInput(runError, "model");
        else await current.recordFailure(runError);
      }
      emitRun({ type: "task", task: ctx.taskView(current) });
    }
    emitRun({ type: "error", message: runError, runId });
    emitRun({ type: "status", phase: current?.state.status === "needs-input" ? "需要回答" : controller.signal.aborted ? "已停止" : "失败", runId });
  } finally {
    const ledger = run.ledger ?? existingLedger;
    if (ledger) {
      try {
        const current = await TaskLedger.load(ledger.file);
        const reason = goalStopReason(current, controller.signal.aborted, webKernel.controlHolder === "user", runError);
        if (reason && current.state.goal?.stopReason !== reason) {
          await current.setGoalProgress(current.state.goal?.noProgressRuns ?? 0, reason);
          emitRun({ type: "task", task: ctx.taskView(current) });
        }
      } catch (error) { console.error("ALPHA_GOAL_STOP_RECORD_FAILED", error); }
    }
    if (beforeSource && ledger) {
      try {
        await writeSourceReview(dataRoot, { taskId: ledger.state.id, operationId: runId, contractVersion: ledger.state.contractVersion ?? 1, revision: ledger.state.revision, before: beforeSource, after: await snapshotSource(projectRoot) });
      } catch (error) { console.error("ALPHA_SOURCE_REVIEW_FAILED", error); }
    }
    if (ledger) { ctx.flushText(ledger.state.id); ctx.operationIds.delete(ledger.state.id); }
    if (controller.signal.aborted && run.ledger) {
      const current = await TaskLedger.load(run.ledger.file).catch(() => null);
      if (current?.state.status === "active") await current.stop();
    }
    if (projectTurn && ledger) {
      try {
        const current = await TaskLedger.load(ledger.file);
        await finalizeProjectTurn(projectTurn, current, writingToolObserved);
        if (!runError && !controller.signal.aborted && current.state.status === "active" && current.state.phase === "execute" && !current.completionGaps().length) await current.complete();
        emitRun({ type: "task", task: ctx.taskView(current) });
      } catch (error) {
        const reason = `项目状态收尾失败：${error instanceof Error ? error.message : String(error)}`;
        runError = runError ?? reason;
        const current = await TaskLedger.load(ledger.file).catch(() => null);
        if (current) await current.recordCheckpointFailure(reason);
        if (current?.state.status === "active") await current.needInput(reason, "project-state");
        if (current) emitRun({ type: "task", task: ctx.taskView(current) });
        emitRun({ type: "error", message: reason, runId });
      }
    }
    if (ledger) await ctx.operationJournal.finish(ledger.state.id, runId);
    const queueItemId = ctx.queuedRuns.get(runId);
    if (queueItemId) {
      ctx.queuedRuns.delete(runId);
      await ctx.taskQueue.finish(queueItemId, runError ?? (controller.signal.aborted ? "cancelled" : ledger ? `task ${ledger.state.status}; pending ${ledger.completionGaps().join(", ") || "none"}` : "no task ledger"), !runError && !controller.signal.aborted);
    }
    const automationRunId = ctx.automationRuns.get(runId);
    if (automationRunId) {
      ctx.automationRuns.delete(runId);
      const current = ledger ? await TaskLedger.load(ledger.file).catch(() => null) : null;
      const status = runError || controller.signal.aborted || !current ? "failed" : current.state.status === "complete" ? "complete" : "needs-input";
      await ctx.automationStore.finish(automationRunId, status, runError ?? (controller.signal.aborted ? "cancelled" : `task ${current?.state.status ?? "unavailable"}`));
    }
    await endRun(ctx, run);
  }
}

/**
 * Answers a follow-up question about a task without changing it: a read-only model run that continues the task's
 * conversation, recorded in the task's activity as a question and its reply.
 */
export function startAnswer(ctx: ServerContext, lease: OperationLease, ledger: TaskLedger, question: string): RunState {
  const run = registerRun(ctx, lease, "answer", ledger);
  const taskId = ledger.state.id;
  const { runId } = run;
  void (async () => {
    ctx.appendActivity(taskId, "question", question, runId);
    ctx.emit({ type: "status", taskId, phase: "回答追问", runId });
    try {
      const configured = await ctx.configuredRun(ledger.state.modelSelector, ledger);
      await runTask({
        ...configured,
        projectRoot: ledger.state.projectRoot, dataRoot: ctx.dataRoot, objective: question, existingLedger: ledger,
        executionMode: "answer", signal: lease.controller.signal,
        onEvent(event) {
          if (event.type === "text") ctx.emit({ type: "text", taskId, value: event.value });
          else if (event.type === "status") ctx.emit({ type: "status", taskId, phase: event.value, runId });
          else ctx.emit({ type: "tool", taskId, name: event.value, state: event.type === "tool-start" ? "开始" : "结束", error: event.error, callId: event.callId, target: event.target, intent: event.intent });
        },
      });
      ctx.emit({ type: "status", taskId, phase: lease.controller.signal.aborted ? "已停止" : "已回答", runId });
    } catch (error) {
      ctx.emit({ type: "error", taskId, message: error instanceof Error ? error.message : String(error), runId });
      ctx.emit({ type: "status", taskId, phase: lease.controller.signal.aborted ? "已停止" : "回答失败", runId });
    } finally {
      ctx.flushText(taskId);
      ctx.operationIds.delete(taskId);
      await endRun(ctx, run);
    }
  })();
  return run;
}

/** Starts queued instructions while capacity allows, passing over tasks that are busy or share a busy folder. */
export async function drainQueue(ctx: ServerContext): Promise<void> {
  if (ctx.state.queueDraining) return;
  ctx.state.queueDraining = true;
  const passed = new Set<string>();
  try {
    while (true) {
      const limit = (await ctx.settingsStore.get()).budget.maxParallelTasks;
      if (ctx.operations.modelOperations >= limit) return;
      const item = await ctx.taskQueue.next(candidate => passed.has(candidate.id) || !!ctx.operations.forTask(candidate.taskId));
      if (!item) return;
      const ledger = await ctx.loadLedger(item.taskId);
      if (!ledger) { await ctx.taskQueue.finish(item.id, "Queued task no longer exists", false); continue; }
      const lease = ctx.operations.claim("run", { ...taskScope(ledger), runLimit: limit });
      if (!lease) { passed.add(item.id); continue; }
      let launched = false;
      try {
        if (!await ctx.taskRootAllowed(ledger)) throw new Error("Queued task workspace is unavailable");
        if (ledger.state.status === "complete") await ledger.reviseObjective(item.instruction);
        else if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(item.instruction);
        else await ledger.recordGuidance(item.instruction);
        const runId = randomUUID();
        await ctx.taskQueue.start(item.id, runId);
        ctx.queuedRuns.set(runId, item.id);
        launched = true;
        launch(ctx, lease, ledger, item.instruction, resolve(ledger.state.projectRoot), { runId });
      } catch (error) {
        await ctx.taskQueue.finish(item.id, error instanceof Error ? error.message : String(error), false);
      } finally {
        if (!launched) ctx.operations.release(lease);
      }
    }
  } finally {
    ctx.state.queueDraining = false;
  }
}

/** Starts due automation runs while capacity allows; a run following a busy task waits for it. */
export async function drainAutomations(ctx: ServerContext): Promise<void> {
  if (ctx.state.automationDraining) return;
  ctx.state.automationDraining = true;
  const passed = new Set<string>();
  try {
    while (true) {
      const limit = (await ctx.settingsStore.get()).budget.maxParallelTasks;
      if (ctx.operations.modelOperations >= limit) return;
      const pending = await ctx.automationStore.next((candidate, automation) => passed.has(candidate.id) || !!(automation?.targetTaskId && ctx.operations.forTask(automation.targetTaskId)));
      if (!pending) return;
      await startAutomation(ctx, pending.id, pending.automationId, limit).then(started => { if (!started) passed.add(pending.id); });
    }
  } finally {
    ctx.state.automationDraining = false;
  }
}

async function startAutomation(ctx: ServerContext, pendingId: string, automationId: string, limit: number): Promise<boolean> {
  let lease: OperationLease | null = null;
  let launched = false;
  try {
    const automation = (await ctx.automationStore.list()).automations.find(item => item.id === automationId);
    if (!automation || automation.status !== "ACTIVE") throw new Error("Automation is no longer active");
    const project = automation.projectId ? await ctx.projectStore.get(automation.projectId) : null;
    const mount = project?.mounts.find(item => item.id === automation.mountId);
    lease = ctx.operations.claim("run", { taskId: automation.targetTaskId ?? null, projectId: project?.id ?? null, roots: mount ? [mount.path] : [], runLimit: limit });
    if (!lease) return false;
    if (automation.modelSelector && !await isModelAvailable(automation.modelSelector)) throw new Error("Automation model is unavailable");
    if (automation.executor === "scoped-git-backup") {
      if (!project || !mount || project.permissionMode !== "full") throw new Error("Scoped backup project is unavailable or lacks full access");
      await verifySandbox({ cwd: mount.path, roots: await ctx.projectStore.roots(project.id, project.version), dataRoot: ctx.dataRoot, network: true, signal: lease.controller.signal });
      const ledger = await TaskLedger.create(ctx.dataRoot, { objective: automation.prompt, projectRoot: mount.path, taskType: "general", criteria: [],
        workspaceOrigin: { kind: "direct" }, projectId: project.id, projectVersion: project.version, permissionMode: "full" });
      ctx.nameTask(ledger, automation.name);
      ctx.operations.bind(lease, { taskId: ledger.state.id });
      await ctx.automationStore.start(pendingId, ledger.state.id, randomUUID());
      ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
      try {
        const result = await scopedGitBackup(mount.path, lease.controller.signal);
        await ledger.complete();
        await ctx.automationStore.finish(pendingId, "complete", result.message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await ledger.needInput(reason, "git-backup");
        await ctx.automationStore.finish(pendingId, "needs-input", reason);
      }
      ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
      return true;
    }
    let ledger: TaskLedger;
    if (automation.kind === "heartbeat") {
      const target = await ctx.loadLedger(automation.targetTaskId!);
      if (!target || !await ctx.taskRootAllowed(target)) throw new Error("Automation target task is unavailable");
      if (!ctx.operations.bind(lease, { projectId: target.state.projectId ?? null, roots: [target.state.projectRoot] })) return false;
      ledger = target;
      if (ledger.state.status === "complete") await ledger.reviseObjective(automation.prompt);
      else if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(automation.prompt);
      else await ledger.recordGuidance(automation.prompt);
      if (automation.modelSelector) await ledger.setModel(automation.modelSelector);
    } else if (project) {
      if (project.mounts.length && !mount) throw new Error("Automation working directory is unavailable");
      const projectRoot = mount?.path ?? join(ctx.productsRoot, `project-${project.id}`);
      if (!mount) {
        await mkdir(projectRoot, { recursive: true });
        if (!ctx.operations.bind(lease, { roots: [projectRoot] })) return false;
      }
      if (mount) await verifySandbox({ cwd: mount.path, roots: await ctx.projectStore.roots(project.id, project.version), dataRoot: ctx.dataRoot, network: project.permissionMode === "full", signal: lease.controller.signal });
      ledger = await TaskLedger.create(ctx.dataRoot, { objective: automation.prompt, projectRoot, taskType: "general", criteria: [],
        workspaceOrigin: { kind: mount ? "direct" : "generated", ...(mount ? { checks: await configuredChecks(mount.path) } : {}) },
        projectId: project.id, projectVersion: project.version, permissionMode: project.permissionMode ?? "ask", modelSelector: automation.modelSelector ?? undefined });
      if (mount) {
        const baseline = await snapshotSourceHashes(projectRoot);
        await mkdir(ctx.directBaselineRoot, { recursive: true });
        await writeFile(join(ctx.directBaselineRoot, `${ledger.state.id}.json`), JSON.stringify({ format: 2, files: baseline }), { flag: "wx" });
      }
    } else {
      ledger = await createGeneralWorkspace({ taskType: "general", objective: automation.prompt, productsRoot: ctx.productsRoot, dataRoot: ctx.dataRoot, modelSelector: automation.modelSelector ?? undefined });
      ctx.operations.bind(lease, { roots: [ledger.state.projectRoot] });
    }
    ctx.nameTask(ledger, automation.name);
    ctx.operations.bind(lease, { taskId: ledger.state.id });
    const runId = randomUUID();
    await ctx.automationStore.start(pendingId, ledger.state.id, runId);
    ctx.automationRuns.set(runId, pendingId);
    launched = true;
    launch(ctx, lease, ledger, automation.prompt, ledger.state.projectRoot, { runId });
    return true;
  } catch (error) {
    await ctx.automationStore.finish(pendingId, "failed", error instanceof Error ? error.message : String(error));
    return true;
  } finally {
    if (!launched && lease) ctx.operations.release(lease);
  }
}
