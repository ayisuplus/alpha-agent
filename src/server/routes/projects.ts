import { verifySandbox } from "../../runtime/sandbox-exec";
import { ID, body, failure, notFound, path, type Route } from "../http";

export const projectRoutes: Route[] = [
  { method: "GET", path: "/api/projects", async handle({ ctx }) { return Response.json({ projects: await ctx.projectStore.list() }); } },
  {
    method: "POST", path: "/api/projects",
    async handle({ ctx, request }) {
      const input = await body<{ name?: unknown }>(request, {});
      try { return Response.json({ project: await ctx.projectStore.create(input.name as string) }, { status: 201 }); }
      catch (error) { return failure(error); }
    },
  },
  {
    method: "PATCH", path: path(`/api/projects/${ID}/settings`),
    async handle({ ctx, request, params: [id] }) {
      const input = await body<{ permissionMode?: unknown }>(request, {});
      try { return Response.json({ project: await ctx.projectStore.setPermission(id, input.permissionMode as "ask" | "auto" | "full") }); }
      catch (error) { return failure(error); }
    },
  },
  {
    // Changing the folders a project may use waits until none of its tasks is running; other projects keep working.
    method: "POST", path: path(`/api/projects/${ID}/mounts`),
    async handle({ ctx, request, params: [id] }) {
      const lease = ctx.operations.claim("mount", { projectId: id, exclusiveProject: true });
      if (!lease) return Response.json({ error: "这个项目有任务正在运行，结束后才能更改挂载目录" }, { status: 409 });
      try {
        const input = await body<{ path?: unknown }>(request, {});
        const project = await ctx.projectStore.mount(id, input.path as string);
        await ctx.pauseTasksForProjectChange(project.id, project.version);
        return Response.json({ project });
      } catch (error) { return failure(error); }
      finally { ctx.operations.release(lease); }
    },
  },
  {
    method: "DELETE", path: path(`/api/projects/${ID}/mounts/${ID}`),
    async handle({ ctx, params: [id, mountId] }) {
      const lease = ctx.operations.claim("mount", { projectId: id, exclusiveProject: true });
      if (!lease) return Response.json({ error: "这个项目有任务正在运行，结束后才能更改挂载目录" }, { status: 409 });
      try {
        const project = await ctx.projectStore.unmount(id, mountId);
        await ctx.pauseTasksForProjectChange(project.id, project.version);
        return Response.json({ project });
      } catch (error) { return failure(error); }
      finally { ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: path(`/api/projects/${ID}/sandbox/check`),
    async handle({ ctx, request, params: [id] }) {
      const lease = ctx.operations.claim("sandbox-check", { projectId: id });
      if (!lease) return Response.json({ error: "Another operation is running" }, { status: 409 });
      try {
        const input = await body<{ mountId?: unknown }>(request, {});
        const project = await ctx.projectStore.get(id);
        const mount = project?.mounts.find(item => item.id === input.mountId);
        if (!project || !mount) return Response.json({ error: "Choose a mounted project folder" }, { status: 400 });
        const roots = await ctx.projectStore.roots(project.id, project.version);
        ctx.operations.update(lease, { phase: "验证 Windows 文件与网络边界" });
        await verifySandbox({ cwd: mount.path, roots, dataRoot: ctx.dataRoot, network: project.permissionMode === "full", signal: lease.controller.signal });
        return Response.json({ ok: true });
      } catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 }); }
      finally { ctx.operations.release(lease); }
    },
  },
  {
    method: "POST", path: path(`/api/tasks/${ID}/project/recheck`),
    async handle({ ctx, params: [id] }) {
      const lease = ctx.operations.claim("sandbox-check", { taskId: id });
      if (!lease) return Response.json({ error: "这个任务正在运行，请等它结束" }, { status: 409 });
      try {
        const ledger = await ctx.loadLedger(id);
        const project = ledger?.state.projectId ? await ctx.projectStore.get(ledger.state.projectId) : null;
        if (!ledger || !project) return notFound("Project task not found");
        const roots = await ctx.projectStore.roots(project.id, project.version);
        if (ledger.state.workspaceOrigin?.kind === "direct") {
          if (!roots.some(root => root.toLowerCase() === ledger.state.projectRoot.toLowerCase())) return Response.json({ error: "The original working directory is no longer mounted; create a new task in the replacement directory" }, { status: 409 });
          await verifySandbox({ cwd: ledger.state.projectRoot, roots, dataRoot: ctx.dataRoot, network: ledger.state.permissionMode === "full", signal: lease.controller.signal });
        }
        await ledger.confirmProjectVersion(project.version);
        ctx.emit({ type: "task", taskId: ledger.state.id, task: ctx.taskView(ledger) });
        return Response.json({ task: ctx.taskView(ledger) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 }); }
      finally { ctx.operations.release(lease); }
    },
  },
];
