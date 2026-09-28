import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isModelAvailable } from "../../runtime/models";
import { TaskLedger } from "../../runtime/task-ledger";
import { snapshotSourceHashes } from "../../runtime/source-review";
import { isModelSelector } from "../../runtime/settings";
import { importCodeWorkspace } from "../../runtime/workspace-import";
import { createGeneralWorkspace } from "../../runtime/general-work";
import { addTaskInputs } from "../../runtime/task-inputs";
import { configuredChecks } from "../../runtime/code-check";
import { verifySandbox } from "../../runtime/sandbox-exec";
import type { ServerContext } from "../context";
import { ID, body, failure, path, type Route } from "../http";
import { claim, drainQueue, launch } from "../runs";

async function validModel(value: unknown): Promise<string | undefined | Response> {
  if (value !== undefined && value !== null && !isModelSelector(value)) return Response.json({ error: "模型格式不正确" }, { status: 400 });
  const model = typeof value === "string" ? value : undefined;
  if (model && !(await isModelAvailable(model))) return Response.json({ error: "这个模型没有可用的认证" }, { status: 400 });
  return model;
}

async function validExpert(ctx: ServerContext, value: unknown): Promise<string | undefined | Response> {
  const expertId = typeof value === "string" && value ? value : undefined;
  if (value != null && value !== "" && (!expertId || !(await ctx.agentPresetStore.enabled()).some(item => item.id === expertId))) return Response.json({ error: "指定专家不存在或未启用" }, { status: 400 });
  return expertId;
}

async function recordBaseline(ctx: ServerContext, ledger: TaskLedger, root: string): Promise<void> {
  const baseline = await snapshotSourceHashes(root);
  await mkdir(ctx.directBaselineRoot, { recursive: true });
  await writeFile(join(ctx.directBaselineRoot, `${ledger.state.id}.json`), JSON.stringify({ format: 2, files: baseline }), { flag: "wx" });
}

export const startRoutes: Route[] = [
  {
    // Web product from the built-in template; the task itself is created inside the run.
    method: "POST", path: "/api/tasks",
    async handle({ ctx, request }) {
      const input = await body<{ brief?: unknown; model?: unknown; expertId?: unknown; startMode?: unknown; continueUntilAccepted?: unknown }>(request, {});
      const launchOptions = ctx.startOptions(input.startMode, input.continueUntilAccepted);
      if (!launchOptions) return Response.json({ error: "Invalid task start options" }, { status: 400 });
      const brief = typeof input.brief === "string" ? input.brief.trim() : "";
      if (!brief) return Response.json({ error: "Brief is required" }, { status: 400 });
      const model = await validModel(input.model);
      if (model instanceof Response) return model;
      const expertId = await validExpert(ctx, input.expertId);
      if (expertId instanceof Response) return expertId;
      const runId = randomUUID();
      const projectRoot = join(ctx.productsRoot, runId);
      const lease = await claim(ctx, "run", { roots: [projectRoot] });
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        await mkdir(ctx.productsRoot, { recursive: true });
        await cp(join(ctx.appRoot, "templates", "web-minimal"), projectRoot, { recursive: true });
        lease.controller.signal.throwIfAborted();
        launched = true;
        launch(ctx, lease, undefined, brief, projectRoot, { runId, newTaskModel: model, designatedExpertId: expertId, launch: launchOptions });
        return Response.json({ runId, projectRoot });
      } finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    // The workbench's main entry: the task is created first and queued, so it starts as soon as capacity allows.
    method: "POST", path: "/api/tasks/general",
    async handle({ ctx, request }) {
      try {
        const form = await request.formData();
        const objective = String(form.get("objective") ?? "").trim();
        const modelValue = form.get("model");
        const model = typeof modelValue === "string" && modelValue ? modelValue : undefined;
        const launchOptions = ctx.startOptions(form.get("startMode") ?? undefined, form.has("continueUntilAccepted") ? form.get("continueUntilAccepted") === "true" : undefined);
        if (!objective || !launchOptions) return Response.json({ error: "Objective and valid start options are required" }, { status: 400 });
        if (model && (!isModelSelector(model) || !(await isModelAvailable(model)))) return Response.json({ error: "Model is unavailable" }, { status: 400 });
        const projectId = String(form.get("projectId") ?? "");
        const mountId = String(form.get("mountId") ?? "");
        const project = projectId ? await ctx.projectStore.get(projectId) : null;
        if (projectId && !project) return Response.json({ error: "Project not found" }, { status: 404 });
        const mount = project?.mounts.find(item => item.id === mountId);
        if (mountId && !mount) return Response.json({ error: "Primary working directory is not mounted" }, { status: 400 });
        if (project?.mounts.length && !mount) return Response.json({ error: "Choose the primary working directory" }, { status: 400 });
        const permissionMode = form.get("permissionMode") ?? project?.permissionMode ?? "ask";
        if (!["ask", "auto", "full"].includes(String(permissionMode))) return Response.json({ error: "Invalid permission mode" }, { status: 400 });
        const roots = project ? await ctx.projectStore.roots(project.id, project.version) : [];
        if (mount) await verifySandbox({ cwd: mount.path, roots, dataRoot: ctx.dataRoot, network: permissionMode === "full", signal: new AbortController().signal });
        const expertValue = form.get("expertId");
        const expertId = typeof expertValue === "string" && expertValue ? expertValue : undefined;
        if (expertId && !(await ctx.agentPresetStore.enabled()).some(item => item.id === expertId)) return Response.json({ error: "指定专家不存在或未启用" }, { status: 400 });
        const capabilities = await ctx.selectedCapabilities(JSON.parse(String(form.get("skillIds") ?? "[]")), JSON.parse(String(form.get("pluginIds") ?? "[]")), !!mount);
        const files = await ctx.uploadedFiles(form.getAll("files"));
        const projectRoot = mount?.path ?? (project ? join(ctx.productsRoot, `project-${project.id}`) : join(ctx.productsRoot, `work-${randomUUID()}`));
        if (!mount) await mkdir(projectRoot, { recursive: true });
        const ledger = await TaskLedger.create(ctx.dataRoot, { objective, projectRoot, taskType: "general", criteria: [],
          workspaceOrigin: { kind: mount ? "direct" : "generated", ...(mount ? { checks: await configuredChecks(mount.path) } : {}) },
          ...(project ? { projectId: project.id, projectVersion: project.version, permissionMode: permissionMode as "ask" | "auto" | "full" } : {}),
          capabilities, modelSelector: model, designatedExpertId: expertId, ...launchOptions,
        });
        await addTaskInputs(ledger, ctx.dataRoot, files);
        ctx.nameTask(ledger);
        await recordBaseline(ctx, ledger, projectRoot);
        await ctx.taskQueue.enqueue(ledger.state.id, objective);
        ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger, true) });
        await drainQueue(ctx);
        const runId = ctx.runForTask(ledger.state.id)?.runId ?? null;
        return Response.json({ taskId: ledger.state.id, runId, queued: !runId });
      } catch (error) { return failure(error); }
    },
  },
  {
    method: "POST", path: "/api/workflows",
    async handle({ ctx, request }) {
      const form = await request.formData();
      const taskType = form.get("taskType");
      const objective = form.get("objective");
      const modelValue = form.get("model");
      const launchOptions = ctx.startOptions(form.get("startMode") ?? undefined, form.has("continueUntilAccepted") ? form.get("continueUntilAccepted") === "true" : undefined);
      if (!launchOptions || form.has("continueUntilAccepted") && !["true", "false"].includes(String(form.get("continueUntilAccepted")))) return Response.json({ error: "Invalid task start options" }, { status: 400 });
      if (taskType !== "research" && taskType !== "file-work" || typeof objective !== "string" || !objective.trim()) return Response.json({ error: "Task type and objective are required" }, { status: 400 });
      const model = typeof modelValue === "string" && modelValue ? modelValue : undefined;
      if (model && (!isModelSelector(model) || !(await isModelAvailable(model)))) return Response.json({ error: "Model is unavailable" }, { status: 400 });
      const lease = await claim(ctx, "run", {});
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        const files = await ctx.uploadedFiles(form.getAll("files"));
        const ledger = await createGeneralWorkspace({ taskType, objective, productsRoot: ctx.productsRoot, dataRoot: ctx.dataRoot, modelSelector: model, files, ...launchOptions });
        ctx.operations.bind(lease, { taskId: ledger.state.id, roots: [ledger.state.projectRoot] });
        if (lease.controller.signal.aborted) { await ledger.stop(); return Response.json({ error: "Task was cancelled", taskId: ledger.state.id }, { status: 409 }); }
        launched = true;
        const run = launch(ctx, lease, ledger, objective, ledger.state.projectRoot);
        return Response.json({ taskId: ledger.state.id, runId: run.runId });
      } catch (error) { return failure(error); }
      finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: "/api/workspaces/import",
    async handle({ ctx, request }) {
      const input = await body<{ sourcePath?: unknown; objective?: unknown; model?: unknown; expertId?: unknown; startMode?: unknown; continueUntilAccepted?: unknown }>(request, {});
      const launchOptions = ctx.startOptions(input.startMode, input.continueUntilAccepted);
      if (!launchOptions) return Response.json({ error: "Invalid task start options" }, { status: 400 });
      const sourcePath = typeof input.sourcePath === "string" ? input.sourcePath.trim() : "";
      const objective = typeof input.objective === "string" ? input.objective.trim() : "";
      if (!sourcePath || !objective) return Response.json({ error: "Source path and objective are required" }, { status: 400 });
      const model = await validModel(input.model);
      if (model instanceof Response) return model;
      const expertId = await validExpert(ctx, input.expertId);
      if (expertId instanceof Response) return expertId;
      const lease = await claim(ctx, "run", {});
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        const ledger = await importCodeWorkspace({ sourcePath, productsRoot: ctx.productsRoot, dataRoot: ctx.dataRoot, objective, modelSelector: model, designatedExpertId: expertId, ...launchOptions });
        ctx.nameTask(ledger);
        ctx.operations.bind(lease, { taskId: ledger.state.id, roots: [ledger.state.projectRoot] });
        if (lease.controller.signal.aborted) { await ledger.stop(); return Response.json({ error: "Import was cancelled", taskId: ledger.state.id }, { status: 409 }); }
        launched = true;
        const run = launch(ctx, lease, ledger, objective, ledger.state.projectRoot);
        return Response.json({ taskId: ledger.state.id, runId: run.runId });
      } finally { if (!launched) ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: path(`/api/projects/${ID}/tasks`),
    async handle({ ctx, request, params: [projectId] }) {
      const input = await body<{ mountId?: unknown; objective?: unknown; model?: unknown; permissionMode?: unknown; expertId?: unknown; startMode?: unknown; continueUntilAccepted?: unknown }>(request, {});
      const launchOptions = ctx.startOptions(input.startMode, input.continueUntilAccepted);
      if (!launchOptions) return Response.json({ error: "Invalid task start options" }, { status: 400 });
      const project = await ctx.projectStore.get(projectId);
      if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
      const mount = project.mounts.find(item => item.id === input.mountId);
      const objective = typeof input.objective === "string" ? input.objective.trim() : "";
      if (!mount || !objective || !["ask", "auto", "full"].includes(input.permissionMode as string)) return Response.json({ error: "Mount, objective and permission mode are required" }, { status: 400 });
      await ctx.projectStore.roots(project.id, project.version);
      const model = await validModel(input.model);
      if (model instanceof Response) return model;
      const expertId = await validExpert(ctx, input.expertId);
      if (expertId instanceof Response) return expertId;
      const lease = await claim(ctx, "run", { projectId: project.id, roots: [mount.path] });
      if (lease instanceof Response) return lease;
      let launched = false;
      try {
        const ledger = await TaskLedger.create(ctx.dataRoot, { objective, projectRoot: mount.path, taskType: "code-change", projectId: project.id, projectVersion: project.version,
          permissionMode: input.permissionMode as "ask" | "auto" | "full", workspaceOrigin: { kind: "direct", checks: await configuredChecks(mount.path) }, modelSelector: model, designatedExpertId: expertId,
          ...launchOptions,
          criteria: [{ id: "change", description: "Source changes are reviewable", kind: "asset" }, { id: "check", description: "Configured project checks pass", kind: "test" }],
        });
        ctx.nameTask(ledger);
        await recordBaseline(ctx, ledger, mount.path);
        ctx.operations.bind(lease, { taskId: ledger.state.id });
        if (lease.controller.signal.aborted) { await ledger.stop(); return Response.json({ error: "Task was cancelled", taskId: ledger.state.id }, { status: 409 }); }
        launched = true;
        const run = launch(ctx, lease, ledger, objective, mount.path);
        return Response.json({ taskId: ledger.state.id, runId: run.runId });
      } finally { if (!launched) ctx.operations.release(lease); }
    },
  },
];
