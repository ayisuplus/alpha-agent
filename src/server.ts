// Alpha's local workbench server. Routes live in src/server/routes, model runs in src/server/runs.ts, and the shared
// state they operate on in src/server/context.ts.
import { join } from "node:path";
import { TaskLedger } from "./runtime/task-ledger";
import { recoverProjectTurn, unfinishedProjectTurns } from "./runtime/project-state";
import { reapIdleLanguageServers } from "./runtime/omp-settings";
import { createServerContext } from "./server/context";
import { dispatch, type Route } from "./server/http";
import { drainAutomations, drainQueue } from "./server/runs";
import { automationRoutes } from "./server/routes/automations";
import { libraryRoutes } from "./server/routes/library";
import { projectRoutes } from "./server/routes/projects";
import { settingsRoutes } from "./server/routes/settings";
import { startRoutes } from "./server/routes/start";
import { taskRoutes } from "./server/routes/tasks";
import { webRoutes } from "./server/routes/web";

const ctx = await createServerContext();
reapIdleLanguageServers();

for (const item of await ctx.operationJournal.reconcile()) console.error("ALPHA_RECONCILED_OPERATION", item);
for (const turn of await unfinishedProjectTurns(ctx.dataRoot)) {
  if (!turn.taskId) continue;
  const ledger = await TaskLedger.load(join(ctx.dataRoot, "tasks", `${turn.taskId}.json`)).catch(() => null);
  if (!ledger) continue;
  try { await recoverProjectTurn(turn, ledger); }
  catch (error) {
    const reason = `项目状态恢复待审阅：${error instanceof Error ? error.message : String(error)}`;
    await ledger.recordCheckpointFailure(reason);
    if (ledger.state.status === "active") await ledger.needInput(reason, "project-state");
    console.error("ALPHA_PROJECT_STATE_RECOVERY", turn.runId, reason);
  }
}
await ctx.taskQueue.reconcile();
await ctx.automationStore.reconcile();

const routes: Route[] = [...startRoutes, ...taskRoutes, ...settingsRoutes, ...libraryRoutes, ...webRoutes, ...projectRoutes, ...automationRoutes];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url);
    const origin = `http://127.0.0.1:${server.port}`;
    // Check every mutating route before dispatch, including queue and worker controls.
    if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("origin") && request.headers.get("origin") !== origin) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/events") {
      if (request.headers.get("origin") !== origin) return new Response("Forbidden", { status: 403 });
      return server.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname.startsWith("/ui")) return ctx.serveUi(url.pathname);
    return await dispatch(routes, { ctx, request, url }) ?? new Response("Not found", { status: 404 });
  },
  websocket: {
    open(socket) { ctx.clients.add(socket); },
    close(socket) { ctx.clients.delete(socket); },
    message() {},
  },
});

console.log(`ALPHA_SERVER_READY ${server.port}`);
await ctx.taskQueue.advanceDue();
await ctx.automationStore.advanceDue();
void drainQueue(ctx);
void drainAutomations(ctx);
const scheduleTimer = setInterval(() => {
  void ctx.taskQueue.advanceDue().then(() => drainQueue(ctx)).catch(error => console.error("ALPHA_SCHEDULE_FAILED", error));
  void ctx.automationStore.advanceDue().then(() => drainAutomations(ctx)).catch(error => console.error("ALPHA_AUTOMATION_FAILED", error));
}, 15_000);
process.on("SIGINT", () => {
  clearInterval(scheduleTimer);
  for (const run of ctx.runs.values()) run.lease.controller.abort();
  for (const preview of ctx.previews.values()) preview.stop();
  server.stop(true);
});
