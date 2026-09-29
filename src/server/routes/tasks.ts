import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { WorkerSupervisor, inspectWorkerAttempt } from "../../runtime/worker-supervisor";
import { AgentMailbox } from "../../runtime/agent-mailbox";
import { isModelAvailable } from "../../runtime/models";
import { TaskLedger, fingerprintSource } from "../../runtime/task-ledger";
import { EventConflictError, readEvents, taskLogDir } from "../../runtime/task-events";
import { summarizeTaskEvents } from "../../runtime/task-event-summary";
import { readSourceReviews } from "../../runtime/source-review";
import { SettingsError, isModelSelector } from "../../runtime/settings";
import { SkillPluginError } from "../../plugins/third-party";
import { applyCodeChanges, reviewCodeApply } from "../../runtime/workspace-apply";
import { addTaskInputs } from "../../runtime/task-inputs";
import { assertWritablePaths, finalizeProjectTurn, prepareProjectTurn, readProjectMemorySnapshot } from "../../runtime/project-state";
import { ID, body, failure, notFound, path, type Route } from "../http";
import { claim, deliverGuidance, drainQueue, launch, startAnswer, taskScope } from "../runs";
import { buildProduct, controlledVerification, publishPreview } from "../verification";
import { taskProfile } from "../../runtime/task-profile";

const ARTIFACT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};

export const taskRoutes: Route[] = [
  {
    method: "GET", path: "/api/tasks",
    async handle({ ctx }) {
      const queued = new Set((await ctx.taskQueue.all()).items.filter(item => item.status === "pending").map(item => item.taskId));
      return Response.json({
        tasks: (await ctx.taskSnapshotList()).map(ledger => ctx.taskSummary(ledger, queued.has(ledger.state.id))),
        runs: [...ctx.runs.values()].map(run => ({ runId: run.runId, taskId: run.taskId, kind: run.kind })),
        operations: ctx.operations.snapshots(),
      });
    },
  },
  {
    method: "GET", path: "/api/tasks/latest",
    async handle({ ctx }) {
      const ledgers = await ctx.taskSnapshotList();
      const queued = new Set((await ctx.taskQueue.all()).items.filter(item => item.status === "pending").map(item => item.taskId));
      return Response.json({ task: ledgers[0] ? ctx.taskView(ledgers[0], queued.has(ledgers[0].state.id)) : null });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.currentLedger(id);
      if (!ledger) return notFound();
      const queued = (await ctx.taskQueue.all()).items.some(item => item.taskId === ledger.state.id && item.status === "pending");
      return Response.json({ task: ctx.taskView(ledger, queued) });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/memory`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      return Response.json({ ...await readProjectMemorySnapshot(ctx.dataRoot, ledger.state.projectRoot, ledger), checkpoint: ledger.state.checkpoint ?? null, error: ledger.state.checkpointError ?? null });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/agents/messages`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const mailbox = new AgentMailbox(ctx.dataRoot, ledger);
      await mailbox.collect();
      return Response.json({ messages: await mailbox.inbox() });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/workers/${ID}`),
    async handle({ ctx, params: [id, workerId] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      try { return Response.json(await inspectWorkerAttempt(ledger, ctx.dataRoot, workerId)); }
      catch (error) { return failure(error, 404); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/workers/${ID}/cancel`),
    async handle({ ctx, params: [id, workerId] }) {
      const supervisor = WorkerSupervisor.forTask(id);
      if (!supervisor) {
        const ledger = await ctx.loadLedger(id);
        const instance = ledger?.state.cognition?.instances?.find(item => item.id === workerId);
        if (!ledger || instance?.status !== "returned" || ctx.operations.forTask(id)) return Response.json({ error: "Worker is not active in this runtime" }, { status: 409 });
        await ledger.updateWorker(workerId, "cancelled", { findings: ["Result discarded by user"] });
        return Response.json({ task: ctx.taskView(ledger) });
      }
      try { await supervisor.cancel(workerId); return Response.json({ task: ctx.taskView(supervisor.ledger) }); }
      catch (error) { return failure(error, 409); }
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/activity`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      ctx.flushText(ledger.state.id);
      return Response.json({ entries: await ctx.activityFor(ledger.state.id).read() });
    },
  },
  {
    // The durable timeline track: what changed the task, straight from its event log. `since` is a sequence cursor.
    method: "GET", path: path(`/api/tasks/${ID}/events`),
    async handle({ ctx, request, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const cursor = Number(new URL(request.url).searchParams.get("since") ?? "0");
      const since = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
      const events = await readEvents(taskLogDir(ledger.file));
      return Response.json({
        seq: events.length ? events[events.length - 1].seq : 0,
        events: summarizeTaskEvents(since ? events.filter(event => event.seq > since) : events),
      });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/reviews`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      return Response.json({ reviews: (await readSourceReviews(ctx.dataRoot, ledger.state.id)).map(item => ({ operationId: item.operationId, contractVersion: item.contractVersion, revision: item.revision, recordedAt: item.recordedAt, paths: item.changes.map(change => change.path) })) });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/reviews/${ID}`),
    async handle({ ctx, params: [id, operationId] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const selected = (await readSourceReviews(ctx.dataRoot, ledger.state.id)).find(item => item.operationId === operationId);
      return selected ? Response.json({ review: selected }) : notFound("Review not found");
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/evidence/${ID}`),
    async handle({ ctx, params: [id, evidenceId] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const detail = await ctx.evidenceDetail(ledger, evidenceId);
      return detail ? Response.json(detail) : notFound("Evidence unavailable");
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/evidence/${ID}/screenshot`),
    async handle({ ctx, params: [id, evidenceId] }) {
      const ledger = await ctx.loadLedger(id);
      const item = ledger?.state.evidence.find(candidate => candidate.id === evidenceId && candidate.kind === "browser");
      if (!item) return new Response("Not found", { status: 404 });
      const file = await ctx.safeEvidencePath(item.source);
      if (!file || extname(file).toLowerCase() !== ".json") return new Response("Not found", { status: 404 });
      const detail = JSON.parse(await readFile(file, "utf8")) as { screenshot?: unknown };
      const screenshot = typeof detail.screenshot === "string" ? await ctx.safeEvidencePath(detail.screenshot) : null;
      return screenshot && extname(screenshot).toLowerCase() === ".png" ? new Response(Bun.file(screenshot), { headers: { "content-type": "image/png" } }) : new Response("Not found", { status: 404 });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/inputs/${ID}`),
    async handle({ ctx, params: [id, inputId] }) {
      const ledger = await ctx.loadLedger(id);
      const item = ledger?.state.inputs?.find(input => input.id === inputId);
      if (!ledger || !item) return new Response("Not found", { status: 404 });
      const file = await realpath(item.path).catch(() => null);
      const allowed = [join(ctx.dataRoot, "task-inputs", ledger.state.id), join(ledger.state.projectRoot, "inputs")];
      if (!file || !allowed.some(root => file.startsWith(root + sep))) return new Response("Not found", { status: 404 });
      const bytes = await readFile(file);
      if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) return new Response("Input changed", { status: 409 });
      return new Response(bytes, { headers: { "content-type": item.mimeType || "application/octet-stream", "content-disposition": `attachment; filename="${encodeURIComponent(item.name)}"` } });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/artifacts/${ID}`),
    async handle({ ctx, url, params: [id, evidenceId] }) {
      const ledger = await ctx.loadLedger(id);
      const file = ledger ? await ctx.safeArtifactPath(ledger, evidenceId) : null;
      if (!file) return new Response("Not found", { status: 404 });
      const type = ARTIFACT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      const disposition = url.searchParams.get("inline") === "1" && ["application/pdf", "image/png", "image/jpeg", "text/plain; charset=utf-8"].includes(type) ? "inline" : "attachment";
      return new Response(Bun.file(file), { headers: { "content-type": type, "content-disposition": `${disposition}; filename="${encodeURIComponent(file.split(sep).at(-1) ?? "artifact")}"` } });
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/screenshot`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger?.state.preview) return new Response("Not found", { status: 404 });
      const latest = ledger.state.evidence.findLast(item => item.kind === "browser" && item.previewId === ledger.state.preview?.id);
      if (latest) {
        const file = await ctx.safeEvidencePath(latest.source);
        if (file) {
          const detail = JSON.parse(await readFile(file, "utf8")) as { screenshot?: unknown };
          const imagePath = typeof detail.screenshot === "string" ? await ctx.safeEvidencePath(detail.screenshot) : null;
          if (imagePath && extname(imagePath).toLowerCase() === ".png") return new Response(Bun.file(imagePath), { headers: { "content-type": "image/png" } });
        }
      }
      const evidence = join(ctx.dataRoot, "evidence");
      const candidates = [`${ledger.state.id}-${ledger.state.preview.id}-plan.png`, `${ledger.state.id}-${ledger.state.preview.id}-narrow.png`, `${ledger.state.id}-narrow.png`].map(name => Bun.file(join(evidence, name)));
      for (const image of candidates) if (await image.exists()) return new Response(image, { headers: { "content-type": "image/png" } });
      return new Response("Not found", { status: 404 });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/model`),
    async handle({ ctx, request, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      if (ctx.operations.forTask(id)) return Response.json({ error: "任务运行中，结束后才能更换模型" }, { status: 409 });
      const input = await body<{ model?: unknown }>(request, {});
      if (input.model !== null && !isModelSelector(input.model)) return Response.json({ error: "模型格式不正确" }, { status: 400 });
      if (typeof input.model === "string" && !(await isModelAvailable(input.model))) return Response.json({ error: "这个模型没有可用的认证" }, { status: 400 });
      await ledger.setModel(typeof input.model === "string" ? input.model : null);
      ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
      return Response.json({ task: ctx.taskView(ledger) });
    },
  },
  {
    method: "PATCH", path: path(`/api/tasks/${ID}/meta`),
    async handle({ ctx, request, params: [id] }) {
      const ledger = await ctx.currentLedger(id);
      if (!ledger) return notFound();
      const patch = await body<{ archived?: unknown } | null>(request, null);
      if (patch?.archived === true && ctx.operations.forTask(id)) return Response.json({ error: "运行中的任务不能归档" }, { status: 409 });
      try {
        await ctx.workbenchMeta.update(ledger.state.id, patch);
        ctx.state.taskMeta = await ctx.workbenchMeta.all();
        const task = ctx.taskView(ledger);
        ctx.emit({ type: "task", taskId: ledger.state.id, task });
        return Response.json({ task });
      } catch (error) {
        if (error instanceof SettingsError) return failure(error);
        throw error;
      }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/skills/${ID}/decision`),
    async handle({ ctx, request, params: [id, proposalId] }) {
      try {
        const input = await request.json() as { decision?: unknown };
        if (input.decision !== "install" && input.decision !== "reject") throw new SkillPluginError("Skill 提案决定无效");
        const running = ctx.runForTask(id)?.ledger;
        let ledger = running ?? await ctx.loadLedger(id);
        if (!ledger) return notFound("任务不存在");
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const proposal = ledger.state.cognition?.skillProposals?.find(item => item.id === proposalId && item.status === "pending");
        if (!proposal) throw new SkillPluginError("Skill 提案不存在或已处理");
        const installedSkillId = input.decision === "install" ? (await ctx.skillPluginStore.installSelectedSkill(proposal)).skillId : undefined;
        try { await ledger.decideSkillProposal(proposal.id, input.decision === "install" ? "installed" : "rejected", installedSkillId); }
        catch (error) {
          if (!(error instanceof EventConflictError) || running) throw error;
          const latest = await ctx.loadLedger(id);
          const pending = latest?.state.cognition?.skillProposals?.find(item => item.id === proposal.id && item.status === "pending");
          if (!latest || !pending || pending.source !== proposal.source || pending.revision !== proposal.revision || pending.path !== proposal.path) throw new SkillPluginError("任务或提案已变化；请刷新后重新决定");
          await latest.decideSkillProposal(proposal.id, input.decision === "install" ? "installed" : "rejected", installedSkillId);
          ledger = latest;
        }
        ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
        return Response.json({ task: ctx.taskView(ledger) });
      } catch (error) { return failure(error); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/experts/${ID}/decision`),
    async handle({ ctx, request, params: [id, proposalId] }) {
      try {
        const input = await request.json() as { decision?: unknown };
        if (input.decision !== "install" && input.decision !== "reject") throw new SkillPluginError("专家提案决定无效");
        const running = ctx.runForTask(id)?.ledger;
        const ledger = running ?? await ctx.loadLedger(id);
        if (!ledger) return notFound("任务不存在");
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const proposal = ledger.state.cognition?.expertProposals?.find(item => item.id === proposalId && item.status === "pending");
        if (!proposal) throw new SkillPluginError("专家提案不存在或已处理");
        // The user's approval is what takes the task-local expert into the library (§4.3); nothing installs silently.
        const installed = input.decision === "install"
          ? await ctx.expertStore.create({ name: proposal.temporaryExpert.name, description: proposal.temporaryExpert.description, instructions: proposal.temporaryExpert.instructions, skillIds: proposal.temporaryExpert.skillIds })
          : undefined;
        await ledger.decideExpertProposal(proposal.id, input.decision === "install" ? "installed" : "rejected", installed?.id);
        ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
        return Response.json({ task: ctx.taskView(ledger), ...(installed ? { installedExpertId: installed.id } : {}) });
      } catch (error) { return failure(error); }
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/approvals`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger || !taskProfile(ledger.state.taskType).commands) return notFound("Code task not found");
      return Response.json({ approvals: await ctx.commandApprovals.list(ledger.state.id) });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/approvals/${ID}/decision`),
    async handle({ ctx, request, params: [id, approvalId] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger || !taskProfile(ledger.state.taskType).commands) return notFound("Code task not found");
      const input = await body<{ approved?: unknown }>(request, {});
      if (typeof input.approved !== "boolean") return Response.json({ error: "Approval decision is required" }, { status: 400 });
      try {
        const approval = await ctx.commandApprovals.decide(ledger.state.id, approvalId, input.approved);
        ctx.appendActivity(ledger.state.id, "status", `命令${input.approved ? "已批准" : "已拒绝"}：${approval.argv.join(" ")}`);
        const supervisor = WorkerSupervisor.forTask(ledger.state.id);
        const owner = supervisor?.ledger ?? ledger;
        const workerRequest = owner.state.workerRequests?.find(item => item.approvalId === approval.id && item.status === "awaiting-approval");
        if (workerRequest) {
          if (input.approved) {
            try {
              if (supervisor) await supervisor.resumeApprovedRequest(workerRequest.id);
              else throw new Error("Coordinator is not running");
            } catch (error) {
              ctx.appendActivity(ledger.state.id, "status", `依赖审批已通过，等待任务恢复：${error instanceof Error ? error.message : String(error)}`);
              await ctx.taskQueue.enqueue(ledger.state.id, `Resume approved dependency request ${workerRequest.id} with alpha_worker_resolve, then inspect and integrate the subagent result.`);
              void drainQueue(ctx);
            }
          } else {
            await owner.updateWorkerRequest(workerRequest.id, { status: "rejected", reason: "User denied the installation command" });
            if (supervisor) {
              try { await supervisor.mailbox.send(workerRequest.agentId, "decision", "User denied the installation command", workerRequest.id, workerRequest.id); }
              catch (error) { ctx.appendActivity(ledger.state.id, "status", `依赖请求已拒绝，但通知子代理失败：${error instanceof Error ? error.message : String(error)}`); }
            }
          }
        }
        return Response.json({ approval });
      } catch (error) { return failure(error, 409); }
    },
  },
  {
    method: "GET", path: path(`/api/tasks/${ID}/apply-review`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      try { return Response.json(await reviewCodeApply(ledger, ctx.dataRoot)); }
      catch (error) { return failure(error, 409); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/apply`),
    async handle({ ctx, request, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const sourceRoot = ledger.state.workspaceOrigin?.sourcePath;
      if (!sourceRoot) return Response.json({ error: "Import source is missing" }, { status: 409 });
      // Applying writes the original project, so it also owns that folder while it runs.
      const lease = await claim(ctx, "apply", { taskId: id, roots: [sourceRoot] });
      if (lease instanceof Response) return lease;
      try {
        const input = await body<{ revision?: unknown }>(request, {});
        if (typeof input.revision !== "string") return Response.json({ error: "Reviewed revision is required" }, { status: 400 });
        const review = await reviewCodeApply(ledger, ctx.dataRoot);
        const turn = await prepareProjectTurn({ dataRoot: ctx.dataRoot, projectRoot: sourceRoot, runId: randomUUID(), ledger });
        await ledger.recordCheckpointStart();
        try { assertWritablePaths(turn, review.changes.map(change => resolve(sourceRoot, change.path))); }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await ledger.recordCheckpointFailure(reason);
          await finalizeProjectTurn(turn, ledger).catch(() => undefined);
          await ledger.recordCheckpointFailure(reason);
          return Response.json({ error: reason }, { status: 409 });
        }
        let changes: Awaited<ReturnType<typeof applyCodeChanges>> = [];
        let applyError: string | null = null;
        try { changes = await applyCodeChanges(ledger, ctx.dataRoot, input.revision); }
        catch (error) { applyError = error instanceof Error ? error.message : String(error); await ledger.recordCheckpointFailure(`应用失败：${applyError}`); }
        try { await finalizeProjectTurn(turn, ledger); }
        catch (error) {
          const reason = `应用后自动提交失败：${error instanceof Error ? error.message : String(error)}`;
          await ledger.recordCheckpointFailure(reason);
          return Response.json({ error: reason }, { status: 409 });
        }
        if (applyError) await ledger.recordCheckpointFailure(`应用失败：${applyError}`);
        ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
        if (applyError) return Response.json({ error: applyError }, { status: 409 });
        ctx.appendActivity(ledger.state.id, "status", `隔离成果已应用回原项目：${changes.length} 个文件`);
        return Response.json({ applied: changes });
      } catch (error) { return failure(error, 409); }
      finally { ctx.operations.release(lease); }
    },
  },
  {
    // Accepts a run id or a task id: with tasks running side by side the workbench may know either.
    method: "POST", path: /^\/api\/tasks\/([^/]+)\/cancel$/,
    handle({ ctx, params: [id] }) {
      const run = ctx.runs.get(id) ?? ctx.runForTask(id);
      if (!run) return Response.json({ error: "Task is not running" }, { status: 404 });
      run.lease.controller.abort();
      return Response.json({ stopping: true });
    },
  },
  {
    method: "POST", path: path(`/api/operations/${ID}/cancel`),
    handle({ ctx, params: [id] }) {
      return ctx.operations.cancel(id) ? Response.json({ stopping: true }) : Response.json({ error: "Operation is not cancellable" }, { status: 404 });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/guidance`),
    async handle({ ctx, request, params: [id] }) {
      const run = ctx.runForTask(id);
      const live = run?.kind === "run" && !!run.steer && !!run.ledger;
      if (ctx.operations.forTask(id) && !live) return Response.json({ error: "Wait for the current operation to finish before saving guidance" }, { status: 409 });
      const input = await body<{ text?: unknown }>(request, {});
      const instruction = typeof input.text === "string" ? input.text.trim() : "";
      if (!instruction) return Response.json({ error: "Guidance is required" }, { status: 400 });
      const ledger = live ? run.ledger! : await ctx.loadLedger(id);
      if (!ledger) return notFound();
      if (ledger.state.status === "complete") return Response.json({ error: "Revise a completed task before adding guidance" }, { status: 409 });
      ctx.setContext(ledger);
      const guidanceId = await ledger.recordGuidance(instruction);
      ctx.appendActivity(ledger.state.id, "guidance", `补充要求已记录：${instruction}`);
      if (live) {
        try { await deliverGuidance(ctx, run, ledger, guidanceId, instruction); }
        catch (error) { console.error("ALPHA_GUIDANCE_DELIVERY_FAILED", error); }
      }
      ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
      return Response.json({ id: guidanceId, status: ledger.state.guidanceHistory?.find(item => item.id === guidanceId)?.status });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/messages`),
    async handle({ ctx, request, params: [id] }) {
      const form = await request.formData();
      const text = String(form.get("text") ?? "").trim();
      const files = await ctx.uploadedFiles(form.getAll("files"));
      const run = ctx.runForTask(id);
      const live = run?.kind === "run" && !!run.steer && !!run.ledger;
      if (!text && !files.length && live) return Response.json({ error: "Message or attachments are required" }, { status: 400 });
      const selected = form.has("skillIds") || form.has("pluginIds");
      if (ctx.operations.forTask(id) && !live) return Response.json({ error: "Wait until this task can accept a message" }, { status: 409 });
      if (live) {
        if (selected) return Response.json({ error: "Skill and plugin changes take effect on the next run" }, { status: 409 });
        const ledger = run.ledger!;
        await addTaskInputs(ledger, ctx.dataRoot, files);
        const instruction = [text, ...files.map(file => `Attached: ${file.name}`)].filter(Boolean).join("\n");
        const guidanceId = await ledger.recordGuidance(instruction);
        ctx.appendActivity(ledger.state.id, "guidance", `补充要求已记录：${instruction}`);
        await deliverGuidance(ctx, run, ledger, guidanceId, instruction);
        ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
        return Response.json({ taskId: ledger.state.id, delivered: true });
      }
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const lease = await claim(ctx, "run", taskScope(ledger));
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Project folders changed; review the project before continuing" }, { status: 409 });
        const capabilities = selected ? await ctx.selectedCapabilities(JSON.parse(String(form.get("skillIds") ?? "[]")), JSON.parse(String(form.get("pluginIds") ?? "[]")), ledger.state.workspaceOrigin?.kind === "direct") : null;
        if (ledger.state.status === "complete" || form.get("forceRevision") === "true") {
          if (!text) return Response.json({ error: "A modification request is required for a completed task" }, { status: 400 });
          await ledger.reviseObjective(text);
        }
        if (capabilities) await ledger.setCapabilities(capabilities);
        await addTaskInputs(ledger, ctx.dataRoot, files);
        const instruction = [text || "Review the newly attached materials and continue the task.", ...files.map(file => `Attached: ${file.name}`)].join("\n");
        if (ledger.state.phase === "plan-review") await ledger.enterPlan();
        else if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(instruction);
        else if (ledger.state.status !== "complete") await ledger.recordGuidance(instruction);
        const runId = randomUUID();
        ctx.appendActivity(ledger.state.id, "guidance", `新消息：${instruction}`, runId);
        launched = true;
        launch(ctx, lease, ledger, instruction, ledger.state.projectRoot, { runId });
        return Response.json({ taskId: ledger.state.id, runId, contractVersion: ledger.state.contractVersion });
      } catch (error) { return failure(error); }
      finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/ask`),
    async handle({ ctx, request, params: [id] }) {
      const input = await body<{ question?: unknown }>(request, {});
      const question = typeof input.question === "string" ? input.question.trim() : "";
      if (!question || question.length > 8_000) return Response.json({ error: "请输入 1–8000 字的问题" }, { status: 400 });
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
      // Answers only read the workspace, so they hold the task but no folder.
      const lease = await claim(ctx, "answer", { taskId: id, projectId: ledger.state.projectId ?? null });
      if (lease instanceof Response) return lease;
      const run = startAnswer(ctx, lease, ledger, question);
      return Response.json({ taskId: id, runId: run.runId });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/plan/enter`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const lease = await claim(ctx, "run", taskScope(ledger));
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        await ledger.enterPlan();
        launched = true;
        const run = launch(ctx, lease, ledger, "Investigate the current task and record a revised plan for user review.", ledger.state.projectRoot);
        return Response.json({ taskId: ledger.state.id, runId: run.runId });
      } catch (error) { return failure(error, 409); }
      finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/plan/approve`),
    async handle({ ctx, request, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const lease = await claim(ctx, "run", taskScope(ledger));
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const input = await body<{ contractVersion?: unknown; cognitionRevision?: unknown; sourceRevision?: unknown }>(request, {});
        if (!Number.isSafeInteger(input.contractVersion) || !Number.isSafeInteger(input.cognitionRevision) || typeof input.sourceRevision !== "string") return Response.json({ error: "Expected plan and source versions are required" }, { status: 400 });
        await ledger.approvePlan({ contractVersion: input.contractVersion as number, cognitionRevision: input.cognitionRevision as number, sourceRevision: input.sourceRevision });
        launched = true;
        const run = launch(ctx, lease, ledger, "Execute the approved plan and verify the current task against its acceptance criteria.", ledger.state.projectRoot);
        return Response.json({ taskId: ledger.state.id, runId: run.runId });
      } catch (error) { return failure(error, 409); }
      finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    method: "PATCH", path: path(`/api/tasks/${ID}/goal`),
    async handle({ ctx, request, params: [id] }) {
      if (ctx.operations.forTask(id)) return Response.json({ error: "Wait for the current operation to finish" }, { status: 409 });
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const input = await body<{ enabled?: unknown }>(request, {});
      if (typeof input.enabled !== "boolean") return Response.json({ error: "Goal continuation setting is required" }, { status: 400 });
      const configured = await ctx.configuredRun(ledger.state.modelSelector, ledger);
      await ledger.setGoal(input.enabled, { maxToolCalls: configured.maxToolCalls, wallTimeMs: configured.wallTimeMs, maxTotalToolCalls: configured.maxTotalToolCalls, totalWallTimeMs: configured.totalWallTimeMs });
      ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
      return Response.json({ task: ctx.taskView(ledger) });
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/revise`),
    async handle({ ctx, request, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const lease = await claim(ctx, "run", taskScope(ledger));
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const input = await body<{ brief?: unknown }>(request, {});
        const brief = typeof input.brief === "string" ? input.brief.trim() : "";
        if (!brief || brief === ledger.state.objective) return Response.json({ error: "A changed task objective is required" }, { status: 400 });
        const previousPreviewId = ledger.state.preview?.id;
        await ledger.reviseObjective(brief);
        lease.controller.signal.throwIfAborted();
        if (previousPreviewId) {
          ctx.previews.get(previousPreviewId)?.stop();
          ctx.previews.delete(previousPreviewId);
        }
        const runId = randomUUID();
        ctx.setContext(ledger);
        ctx.appendActivity(ledger.state.id, "status", `目标修订至 v${ledger.state.contractVersion}`, runId);
        launched = true;
        launch(ctx, lease, ledger, brief, resolve(ledger.state.projectRoot), { runId });
        return Response.json({ runId, taskId: ledger.state.id, contractVersion: ledger.state.contractVersion });
      } finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/resume`),
    async handle({ ctx, request, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const lease = await claim(ctx, "run", taskScope(ledger));
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        if (ledger.state.status === "complete") return Response.json({ error: "Task is already complete" }, { status: 409 });
        if (ledger.state.phase === "plan-review") return Response.json({ error: "Review the plan before execution or return to planning" }, { status: 409 });
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const input = await body<{ brief?: unknown }>(request, {});
        const correction = typeof input.brief === "string" && input.brief.trim() ? input.brief.trim() : ledger.state.phase === "plan" ? "Continue investigating and revise the plan for review." : "Repair the pending acceptance checks while preserving the original objective.";
        if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(correction);
        else await ledger.recordGuidance(correction);
        lease.controller.signal.throwIfAborted();
        launched = true;
        const run = launch(ctx, lease, ledger, correction, resolve(ledger.state.projectRoot));
        return Response.json({ runId: run.runId, taskId: ledger.state.id });
      } finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/publish`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const lease = await claim(ctx, "publish", taskScope(ledger));
      if (lease instanceof Response) return lease;
      try {
        ctx.setContext(ledger);
        const publishRunId = randomUUID();
        ctx.operationIds.set(ledger.state.id, publishRunId);
        if (ledger.state.status === "stopped") return Response.json({ error: "Task is stopped" }, { status: 409 });
        const projectRoot = resolve(ledger.state.projectRoot);
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const currentPreview = ledger.state.preview;
        if (currentPreview && ctx.previews.has(currentPreview.id) && (await fingerprintSource(projectRoot)) === currentPreview.revision) return Response.json(currentPreview);
        if (ledger.state.status === "complete") await ledger.reopen("Local preview was republished and needs browser verification");
        if (!ledger.state.development?.enabled && taskProfile(ledger.state.taskType).defaultGates.length > 0) await ledger.enableDevelopmentWorkflow();
        await ledger.refreshRevision();
        const controller = lease.controller;
        if (!(await buildProduct(ctx, projectRoot, ledger, controller.signal))) return Response.json({ error: "Build failed" }, { status: 422 });
        const instance = await publishPreview(ctx, ledger, projectRoot);
        ctx.emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: publishRunId, pending: ledger.completionGaps() });
        ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
        ctx.emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: publishRunId, pending: ledger.completionGaps() });
        try {
          await controlledVerification(ctx, ledger, controller.signal, lease);
          const verified = await TaskLedger.load(ledger.file);
          ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(verified) });
          ctx.emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
          ctx.emit({ type: "status", taskId: ledger.state.id, phase: verified.completionGaps().length ? "待验收" : "已验收", runId: publishRunId, pending: verified.completionGaps() });
        } catch (error) {
          const current = await TaskLedger.load(ledger.file);
          if (ctx.webKernel.controlHolder === "user") {
            ctx.emit({ type: "status", taskId: ledger.state.id, phase: "用户接管", runId: publishRunId, pending: current.completionGaps() });
            return Response.json(instance.record);
          }
          if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
          ctx.emit({ type: "error", taskId: ledger.state.id, message: `浏览器验收未通过：${error instanceof Error ? error.message : String(error)}` });
          ctx.emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: publishRunId, pending: current.completionGaps() });
        }
        return Response.json(instance.record);
      } finally {
        ctx.operationIds.delete(id);
        ctx.operations.release(lease);
      }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/verify`),
    async handle({ ctx, params: [id] }) {
      const ledger = await ctx.loadLedger(id);
      if (!ledger) return notFound();
      const lease = await claim(ctx, "verify", { taskId: id });
      if (lease instanceof Response) return lease;
      try {
        if (ledger.state.status !== "active" || !ledger.state.preview || !ctx.previews.has(ledger.state.preview.id)) return Response.json({ error: "A live active preview is required" }, { status: 409 });
        if (!await ctx.taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        if (!ledger.state.development?.enabled && taskProfile(ledger.state.taskType).defaultGates.length > 0) await ledger.enableDevelopmentWorkflow();
        ctx.setContext(ledger);
        const verifyRunId = randomUUID();
        ctx.operationIds.set(ledger.state.id, verifyRunId);
        try {
          ctx.emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: verifyRunId, pending: ledger.completionGaps() });
          await controlledVerification(ctx, ledger, lease.controller.signal, lease);
          const verified = await TaskLedger.load(ledger.file);
          ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(verified) });
          ctx.emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
          ctx.emit({ type: "status", taskId: ledger.state.id, phase: verified.completionGaps().length ? "待验收" : "已验收", runId: verifyRunId, pending: verified.completionGaps() });
          return Response.json({ task: ctx.taskView(verified) });
        } catch (error) {
          const current = await TaskLedger.load(ledger.file);
          if (ctx.webKernel.controlHolder === "user") {
            ctx.emit({ type: "status", taskId: ledger.state.id, phase: "用户接管", runId: verifyRunId, pending: current.completionGaps() });
            return Response.json({ paused: true, task: ctx.taskView(current) }, { status: 202 });
          }
          if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
          ctx.emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: verifyRunId, pending: current.completionGaps() });
          return Response.json({ error: error instanceof Error ? error.message : String(error), task: ctx.taskView(current) }, { status: 422 });
        } finally {
          ctx.operationIds.delete(ledger.state.id);
        }
      } finally {
        ctx.operations.release(lease);
      }
    },
  },
];
