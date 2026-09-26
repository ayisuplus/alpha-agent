import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { AgentPresetStore } from "./agent-presets";
import { runTask, type RunOptions } from "./omp-runner";
import { snapshotSource, sourceChanges } from "./source-review";
import type { TaskLedger } from "./task-ledger";
import { WorkerSupervisor, inspectWorkerAttempt } from "./worker-supervisor";
import { validateReviewEvidence } from "./development-review-tool";
import type { WorkOrder } from "./work-orders";

function isDevelopment(ledger: TaskLedger): boolean {
  return ledger.state.taskType === "web-product" || ledger.state.taskType === "code-change";
}

function currentReviewPassed(ledger: TaskLedger): boolean {
  const review = ledger.state.development?.review;
  return review?.verdict === "pass" && review.revision === ledger.state.revision && review.contractVersion === (ledger.state.contractVersion ?? 1);
}

export async function runDevelopmentWorkflow(options: RunOptions): Promise<TaskLedger> {
  if (options.workOrder || options.executionMode || options.existingLedger?.state.phase === "plan" || options.startMode === "plan") return runTask(options);
  const before = await snapshotSource(options.projectRoot);
  const coordinatorId = randomUUID();
  const designated = options.existingLedger?.state.designatedExpertId;
  const coordinatorExpert = designated ? (await new AgentPresetStore(options.dataRoot).enabled()).find(item => item.id === designated) : undefined;
  if (designated && !coordinatorExpert) throw new Error(`用户指定专家已停用或删除：${designated}`);
  let createdLedger: TaskLedger | undefined;
  let ledger: TaskLedger;
  let supervisor: WorkerSupervisor | undefined;
  let currentToolCalls = 0;
  let currentRunStartedAt = Date.now();
  const observe = (event: Parameters<NonNullable<RunOptions["onEvent"]>>[0]) => { if (event.type === "tool-start") currentToolCalls++; options.onEvent?.(event); };
  const workerOptions = { ...options, onEvent: observe,
    onSessionReady: async (steer: (text: string) => Promise<void>) => { supervisor?.setCoordinatorSteer(steer); await options.onSessionReady?.(steer); },
    onSessionEnd: async (queued: readonly string[], completed: boolean) => { supervisor?.setCoordinatorSteer(); await options.onSessionEnd?.(queued, completed); },
    getWorkerSupervisor: () => {
    if (!supervisor) throw new Error("Worker supervisor is not ready");
    return supervisor;
  } };
  try {
    ledger = await runTask({ ...workerOptions, async onLedger(created) {
      createdLedger = created;
      if (isDevelopment(created)) {
        await created.enableDevelopmentWorkflow();
        await created.recordDispatch({ id: coordinatorId, orderId: "coordinator", mode: "implement", expert: coordinatorExpert ? { id: coordinatorExpert.id, name: coordinatorExpert.name, hash: coordinatorExpert.hash } : undefined, skills: coordinatorExpert?.package?.skills.map(item => ({ id: item.id, hash: item.hash, revision: coordinatorExpert.package!.revision })) ?? [] });
      }
      supervisor = new WorkerSupervisor({ ledger: created, dataRoot: options.dataRoot, parentId: coordinatorId, modelSelector: options.modelSelector, signal: options.signal, browser: options.browser, browserUrl: options.browserUrl, browserAccess: options.browserAccess, plugins: options.plugins, generation: options.generation, comfyUrl: options.comfyUrl,
        remainingCalls: () => (options.maxTotalToolCalls ?? 1200) - (created.state.runs ?? []).reduce((sum, run) => sum + run.toolCalls, 0) - currentToolCalls,
        remainingTimeMs: () => (options.totalWallTimeMs ?? 7_200_000) - (created.state.runs ?? []).reduce((sum, run) => sum + run.elapsedMs, 0) - (Date.now() - currentRunStartedAt),
        onStatus: value => options.onEvent?.({ type: "status", value }), onChange: () => options.onWorkerState?.(created) });
      await options.onLedger?.(created);
    } });
    let followups = 0;
    await supervisor?.mailbox.collect();
    while ((supervisor?.unsettled || supervisor?.hasMessages) && ledger.state.status === "active" && !options.signal?.aborted) {
      const outstanding = (ledger.state.cognition?.instances ?? []).filter(item => item.order && ["queued", "running", "returned"].includes(item.status)).map(item => item.id);
      if (supervisor.running && !supervisor.needsIntegration && !supervisor.hasMessages) { await supervisor.wait(outstanding, 60_000); continue; }
      if (followups++ >= 3) {
        await ledger.needInput("子实例结果或消息仍待主代理处理，请检查实例记录和消息箱后继续。", "worker-integration");
        break;
      }
      currentToolCalls = 0;
      currentRunStartedAt = Date.now();
      ledger = await runTask({ ...workerOptions, existingLedger: ledger, objective: "Read alpha_inbox and handle pending subagent messages. Inspect each returned worker result and diff. Integrate accepted results one at a time; resolve conflicts or cancel unneeded attempts. Do not claim final acceptance before integration.", onLedger: undefined });
      await supervisor.mailbox.collect();
    }
    if (ledger.state.status !== "active" || options.signal?.aborted) await supervisor?.cancelExecuting();
    if (isDevelopment(ledger)) await ledger.finishDispatch(coordinatorId, options.signal?.aborted ? "cancelled" : supervisor?.unsettled || supervisor?.hasMessages || ledger.state.status !== "active" ? "blocked" : "completed");
  } catch (error) {
    await supervisor?.cancelExecuting();
    if (createdLedger?.state.cognition?.instances?.some(item => item.id === coordinatorId)) await createdLedger.finishDispatch(coordinatorId, options.signal?.aborted ? "cancelled" : "failed", [error instanceof Error ? error.message : String(error)]);
    throw error;
  }
  if (!isDevelopment(ledger) || ledger.state.phase === "plan-review") return ledger;
  if (supervisor?.unsettled || supervisor?.hasMessages) return ledger;
  if (!ledger.state.development?.enabled) await ledger.enableDevelopmentWorkflow();
  if (ledger.state.status !== "active" || options.signal?.aborted) return ledger;
  let comparison = before;
  while (!currentReviewPassed(ledger)) {
    const after = await snapshotSource(options.projectRoot);
    const changes = sourceChanges(comparison, after);
    const changedPaths = changes.map(item => item.path).slice(0, 80).join(", ") || "no source change in this run";
    const actualDiff = changes.slice(0, 20).map(item => createTwoFilesPatch(`before/${item.path}`, `after/${item.path}`, item.before ?? "", item.after ?? "").slice(0, 8_000)).join("\n").slice(0, 32_000);
    const reviewStep = ledger.state.cognition?.steps.find(step => step.mode === "review" && step.expertId);
    const reviewExpert = reviewStep?.expertId ? (await new AgentPresetStore(options.dataRoot).enabled()).find(item => item.id === reviewStep.expertId) : undefined;
    if (reviewStep?.expertId && !reviewExpert) throw new Error(`计划中的审查专家已停用或删除：${reviewStep.expertId}`);
    if (!reviewExpert?.package?.skills.length) {
      await ledger.needInput("独立最终审查需要在认知计划中指定带 Skill 的版本化审查专家。", "review-expert");
      return ledger;
    }
    if (!supervisor) throw new Error("Worker supervisor is not ready for final review");
    const reviewedRevision = ledger.state.revision;
    const reviewedContract = ledger.state.contractVersion ?? 1;
    const instanceId = randomUUID();
    const reviewOrder: WorkOrder = {
      id: reviewStep?.id ?? "final-review", agentId: randomUUID(), instanceId, mode: "review", fullAccess: true, ownedPaths: [], readPaths: ["."], resources: ["final-review"], contractVersion: reviewedContract, baseRevision: reviewedRevision ?? undefined,
      objective: `Review source correctness against this task: ${ledger.state.objective}. Acceptance criteria: ${ledger.state.criteria.map(item => `${item.id}: ${item.description}`).join(" | ")}. Configured tests and browser checks are separate. Changed paths this run: ${changedPaths}. Actual bounded diff:\n${actualDiff || "No text diff captured; inspect current source and task evidence."}\nRead source without changing it. Submit alpha_worker_result with a review verdict and exact current source evidence when passing. Send findings to the primary agent.`,
      skillIds: [...new Set([...(reviewExpert?.skillIds ?? []), ...(reviewStep?.skillIds ?? [])])],
      ...(reviewExpert ? { expertId: reviewExpert.id, presetId: reviewExpert.id, preset: reviewExpert } : {}),
    };
    options.onEvent?.({ type: "status", value: `独立工作树审查 · ${reviewExpert?.name ?? "通用执行"}` });
    currentToolCalls = 0;
    currentRunStartedAt = Date.now();
    try { await supervisor.spawn([reviewOrder]); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Parallel workers require")) {
        await ledger.needInput("当前项目需要 Git 仓库根目录和至少一次提交，才能启动独立 worktree 审查。", "git-worktree");
        return ledger;
      }
      throw error;
    }
    while (["queued", "running"].includes(ledger.state.cognition?.instances?.find(item => item.id === instanceId)?.status ?? "") && ledger.state.status === "active" && !options.signal?.aborted) await supervisor.wait([instanceId], 60_000, false);
    if (ledger.state.status !== "active" || options.signal?.aborted) return ledger;
    if (ledger.state.cognition?.instances?.find(item => item.id === instanceId)?.status !== "returned") {
      await ledger.needInput("独立审查子实例未返回可检查结果，请检查实例记录。", "worker-review");
      return ledger;
    }
    currentToolCalls = 0;
    currentRunStartedAt = Date.now();
    ledger = await runTask({ ...workerOptions, existingLedger: ledger,
      objective: `Inspect final-review worker ${instanceId} and its diff with alpha_inspect. Integrate accepted changes with alpha_integrate, or cancel the attempt if its changes should be rejected. The review verdict is recorded only after your decision.`,
      onLedger: undefined });
    const reviewAttempt = await inspectWorkerAttempt(ledger, options.dataRoot, instanceId);
    const reviewResult = reviewAttempt.report?.results[reviewOrder.id];
    const status = reviewAttempt.instance.status;
    if (!reviewResult?.reviewVerdict || (status !== "completed" && !(status === "cancelled" && reviewResult.reviewVerdict !== "pass"))) {
      if (ledger.state.status === "active") await ledger.needInput("独立审查结果仍待主代理检查和处理。", "worker-review");
      return ledger;
    }
    const evidence = await validateReviewEvidence(options.projectRoot, reviewResult.reviewEvidence ?? []);
    if (reviewResult.reviewVerdict === "pass" && !evidence.length) throw new Error("Passing review has no current source evidence");
    await ledger.refreshRevision();
    if (ledger.state.revision !== reviewedRevision || (ledger.state.contractVersion ?? 1) !== reviewedContract) { comparison = after; continue; }
    await ledger.recordDevelopmentReview({ verdict: reviewResult.reviewVerdict, findings: reviewResult.findings?.length ? reviewResult.findings : ["Source review passed"], evidence, instanceId, expectedRevision: reviewedRevision!, expectedContractVersion: reviewedContract });
    if (ledger.state.status !== "active" || ledger.state.phase === "plan-review" || options.signal?.aborted || currentReviewPassed(ledger)) return ledger;
    const review = ledger.state.development?.review;
    if (review?.verdict !== "changes-requested" || !review.findings.length || (ledger.state.development?.repairAttempts ?? 0) >= 2) return ledger;
    await ledger.recordRepairAttempt();
    const oldRevision = ledger.state.revision;
    options.onEvent?.({ type: "status", value: `按审查意见修复 · 第 ${ledger.state.development?.repairAttempts} 轮` });
    comparison = after;
    const implementer = ledger.state.cognition?.agents?.findLast(agent => agent.mode === "implement" && agent.status === "completed");
    if (implementer) {
      const repairRunId = await supervisor.continue(implementer.id, `Fix independent review findings: ${review.findings.join(" | ")}`, "implement");
      while (["queued", "running"].includes(ledger.state.cognition?.instances?.find(item => item.id === repairRunId)?.status ?? "") && ledger.state.status === "active" && !options.signal?.aborted) await supervisor.wait([repairRunId], 60_000, false);
      if (ledger.state.cognition?.instances?.find(item => item.id === repairRunId)?.status !== "returned") {
        await ledger.needInput("原实施子代理未返回可检查的修复结果，请检查消息和实例记录。", "review-repair");
        return ledger;
      }
      currentToolCalls = 0;
      currentRunStartedAt = Date.now();
      ledger = await runTask({ ...workerOptions, existingLedger: ledger, objective: `Inspect repair run ${repairRunId} with alpha_inspect and integrate its changes with alpha_integrate only if they address these findings: ${review.findings.join(" | ")}. Handle alpha_inbox first.`, onLedger: undefined });
      if (ledger.state.cognition?.instances?.find(item => item.id === repairRunId)?.status !== "completed") {
        await ledger.needInput("审查修复尚未由主代理集成。", "review-repair");
        return ledger;
      }
    } else {
      const repairId = randomUUID();
      await ledger.recordDispatch({ id: repairId, orderId: "review-repair", mode: "implement", skills: [] });
      try {
        ledger = await runTask({ ...workerOptions, existingLedger: ledger, objective: `Fix these independent review findings while preserving the task contract: ${review.findings.join(" | ")}`, onLedger: undefined });
        await ledger.finishDispatch(repairId, ledger.state.revision === oldRevision ? "blocked" : "completed", ledger.state.revision === oldRevision ? ["No source change after repair"] : []);
      } catch (error) {
        await ledger.finishDispatch(repairId, options.signal?.aborted ? "cancelled" : "failed", [error instanceof Error ? error.message : String(error)]);
        throw error;
      }
    }
    if (ledger.state.status !== "active" || ledger.state.phase === "plan-review" || options.signal?.aborted || ledger.state.revision === oldRevision) return ledger;
  }
  return ledger;
}
