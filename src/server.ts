import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { cp, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { publishLocalPreview, type PreviewInstance } from "./runtime/local-preview";
import { runTask } from "./runtime/omp-runner";
import { TaskLedger, fingerprintSource } from "./runtime/task-ledger";
import { assertGeneratedAssetsIntact } from "./runtime/media-integrity";
import { verifyBrowserPlan } from "./runtime/browser-verifier";

const appRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? appRoot);
const dataRoot = join(workspaceRoot, ".alpha");
const productsRoot = join(workspaceRoot, "products");
const uiRoot = join(appRoot, "desktop", "dist");
for (const directory of [dataRoot, productsRoot]) {
  const probe = join(directory, `.alpha-write-probe-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "");
    await unlink(probe);
  } catch (error) {
    throw new Error(`Alpha local workspace is not writable: ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const clients = new Set<ServerWebSocket<unknown>>();
const previews = new Map<string, PreviewInstance>();
let active: { runId: string; controller: AbortController; ledger?: TaskLedger } | null = null;
let controlHolder: "alpha" | "user" = "alpha";
let verification: { taskId: string; controller: AbortController } | null = null;
let publishing = false;

async function loadLedger(id: string): Promise<TaskLedger | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return TaskLedger.load(join(dataRoot, "tasks", `${id}.json`)).catch(() => null);
}

function taskView(ledger: TaskLedger) {
  const preview = ledger.state.preview;
  const evidence = ledger.state.evidence.filter(item => (item.contractVersion ?? 1) === (ledger.state.contractVersion ?? 1) && item.revision === ledger.state.revision && (item.kind !== "browser" || item.previewId === preview?.id));
  return {
    id: ledger.state.id,
    objective: ledger.state.objective,
    contractVersion: ledger.state.contractVersion ?? 1,
    status: ledger.state.status,
    running: active?.ledger?.state.id === ledger.state.id,
    pending: ledger.completionGaps(),
    criteria: ledger.state.criteria,
    lastFailure: ledger.state.lastFailure ?? null,
    reopenReason: ledger.state.reopenReason ?? null,
    latestRun: ledger.state.runs?.at(-1) ?? null,
    evidence: evidence.map(item => ({ id: item.id, criterionId: item.criterionId, kind: item.kind, passed: item.passed, source: item.source, recordedAt: item.recordedAt })),
    screenshotUrl: preview && evidence.some(item => item.kind === "browser") ? `/api/tasks/${ledger.state.id}/screenshot` : null,
    preview: preview ? { ...preview, live: previews.has(preview.id) } : null,
    updatedAt: ledger.state.updatedAt,
  };
}

async function listTasks(): Promise<TaskLedger[]> {
  const names = (await readdir(join(dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const ledgers = (await Promise.all(names.map(name => TaskLedger.load(join(dataRoot, "tasks", name)).catch(() => null)))).filter((ledger): ledger is TaskLedger => ledger !== null);
  return ledgers.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
}

function taskSummary(ledger: TaskLedger) {
  return {
    id: ledger.state.id,
    objective: ledger.state.objective,
    contractVersion: ledger.state.contractVersion ?? 1,
    status: ledger.state.status,
    running: active?.ledger?.state.id === ledger.state.id,
    pendingCount: ledger.completionGaps().length,
    updatedAt: ledger.state.updatedAt,
  };
}

function emit(message: unknown): void {
  const data = JSON.stringify(message);
  for (const client of clients) client.send(data);
}

function serveUi(pathname: string): Response {
  const path = pathname === "/ui" || pathname === "/ui/" ? "/index.html" : pathname.slice(3);
  const file = resolve(uiRoot, `.${path}`);
  if (file !== uiRoot && !file.startsWith(uiRoot + sep)) return new Response("Forbidden", { status: 403 });
  const body = Bun.file(file);
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] ?? "application/octet-stream";
  return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
}

async function build(projectRoot: string, ledger: TaskLedger, signal: AbortSignal): Promise<boolean> {
  await assertGeneratedAssetsIntact(projectRoot, dataRoot);
  const child = Bun.spawn([process.execPath, "run", "build"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const log = `${stdout}\n${stderr}`;
    const logPath = join(dataRoot, "build-logs", `${ledger.state.id}-${randomUUID()}.log`);
    await mkdir(join(dataRoot, "build-logs"), { recursive: true });
    await writeFile(logPath, log);
    emit({ type: "tool", taskId: ledger.state.id, name: "build", state: exitCode === 0 ? "通过" : "失败", error: exitCode !== 0 });
    if (exitCode !== 0 || signal.aborted) return false;
    await assertGeneratedAssetsIntact(projectRoot, dataRoot);
    await ledger.recordEvidence({ criterionId: "build", kind: "build", passed: true, revision: ledger.state.revision!, source: logPath });
    return true;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

async function publishPreview(ledger: TaskLedger, projectRoot: string): Promise<PreviewInstance> {
  const previousId = ledger.state.preview?.id;
  const instance = await publishLocalPreview({ projectRoot, buildDir: join(projectRoot, "dist"), dataRoot, revision: ledger.state.revision!, taskId: ledger.state.id });
  try {
    await ledger.recordPreview(instance.record);
  } catch (error) {
    instance.stop();
    throw error;
  }
  previews.set(instance.record.id, instance);
  if (previousId) {
    previews.get(previousId)?.stop();
    previews.delete(previousId);
  }
  emit({ type: "preview", taskId: ledger.state.id, url: instance.record.url, previewId: instance.record.id, pending: ledger.completionGaps() });
  return instance;
}

async function verifyTaskBrowser(ledger: TaskLedger, signal: AbortSignal): Promise<void> {
  const cdpPort = process.env.ALPHA_CDP_PORT;
  if (!cdpPort || !/^\d+$/.test(cdpPort)) throw new Error("Desktop browser debugging port is unavailable");
  if (await Bun.file(join(ledger.state.projectRoot, "alpha-verification.json")).exists()) {
    await verifyBrowserPlan(ledger, Number(cdpPort), dataRoot, signal);
    return;
  }
  if (!/素材清单|inventory/i.test(ledger.state.objective)) throw new Error("Verification plan is missing: alpha-verification.json");
  const child = Bun.spawn([process.execPath, "run", "scripts/verify-inventory.ts", ledger.file, cdpPort], {
    cwd: appRoot, stdout: "pipe", stderr: "pipe",
  });
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

async function controlledVerification(ledger: TaskLedger, signal: AbortSignal): Promise<void> {
  if (controlHolder !== "alpha") throw new Error("User controls the visible browser");
  if (verification) throw new Error("Another browser verification is running");
  const controller = new AbortController();
  verification = { taskId: ledger.state.id, controller };
  try {
    await verifyTaskBrowser(ledger, AbortSignal.any([signal, controller.signal]));
  } finally {
    if (verification?.controller === controller) verification = null;
  }
}

async function execute(runId: string, objective: string, projectRoot: string, controller: AbortController, existingLedger?: TaskLedger): Promise<void> {
  const emitRun = (message: Record<string, unknown>) => emit({ ...message, taskId: active?.runId === runId ? active.ledger?.state.id : existingLedger?.state.id });
  try {
    emitRun({ type: "status", phase: "构建中", runId });
    const forwardEvent = (event: { type: "text" | "tool-start" | "tool-end"; value: string; error?: boolean }) => {
      if (event.type === "text") emitRun({ type: "text", value: event.value });
      else emitRun({ type: "tool", name: event.value, state: event.type === "tool-start" ? "开始" : "结束", error: event.error });
    };
    const ledger = await runTask({
      projectRoot, objective, dataRoot, signal: controller.signal, existingLedger,
      onEvent: forwardEvent,
      onLedger(created) {
        if (active?.runId === runId) active.ledger = created;
        emitRun({ type: "task", task: taskView(created) });
      },
    });
    if (active?.runId === runId) active.ledger = ledger;
    emitRun({ type: "task", task: taskView(ledger) });
    if (controller.signal.aborted) {
      emitRun({ type: "status", phase: "已停止", runId, pending: ledger.completionGaps() });
      return;
    }
    emitRun({ type: "status", phase: "验证构建", runId });
    if (!(await build(projectRoot, ledger, controller.signal))) {
      emitRun({ type: "status", phase: controller.signal.aborted ? "已停止" : "失败", runId, pending: ledger.completionGaps() });
      return;
    }
    emitRun({ type: "status", phase: "发布本机预览", runId });
    await publishPreview(ledger, projectRoot);
    {
      for (let attempt = 0; attempt < 2; attempt++) {
        emitRun({ type: "status", phase: "浏览器验收", runId });
        try {
          await controlledVerification(await TaskLedger.load(ledger.file), controller.signal);
          const verified = await TaskLedger.load(ledger.file);
          emitRun({ type: "task", task: taskView(verified) });
          emitRun({ type: "tool", name: "browser", state: "通过" });
          emitRun({ type: "status", phase: "已验收", runId, pending: verified.completionGaps() });
          return;
        } catch (error) {
          if (controlHolder === "user") {
            emitRun({ type: "status", phase: "用户接管", runId, pending: (await TaskLedger.load(ledger.file)).completionGaps() });
            return;
          }
          const reason = error instanceof Error ? error.message : String(error);
          emitRun({ type: "tool", name: "browser", state: `验收失败：${reason.slice(0, 400)}`, error: true });
          const current = await TaskLedger.load(ledger.file);
          if (current.state.status === "active") await current.recordFailure(reason);
          const latestBrowser = current.state.evidence.findLast(item => item.criterionId === "user-path" && item.previewId === current.state.preview?.id);
          if (controller.signal.aborted || attempt === 1 || (latestBrowser?.passed !== false && !reason.includes("Verification plan"))) break;
          emitRun({ type: "status", phase: "修复中", runId, pending: current.completionGaps() });
          const failedRevision = current.state.revision;
          const repaired = await runTask({
            projectRoot, dataRoot, signal: controller.signal, existingLedger: current,
            objective: `Visible browser acceptance failed: ${reason}. Read the failure evidence and inspect the exact failing step. Decide whether the product or the verification plan is wrong; preserve the original requirements and do not change product code to fix an invalid test selector. Then rebuild.`,
            onEvent: forwardEvent,
          });
          if (controller.signal.aborted || repaired.state.revision === failedRevision) break;
          emitRun({ type: "status", phase: "验证构建", runId });
          if (!(await build(projectRoot, repaired, controller.signal))) break;
          emitRun({ type: "status", phase: "发布本机预览", runId });
          await publishPreview(repaired, projectRoot);
        }
      }
    }
    const current = await TaskLedger.load(ledger.file);
    emitRun({ type: "status", phase: "待验收", runId, pending: current.completionGaps() });
  } catch (error) {
    const current = active?.runId === runId && active.ledger ? await TaskLedger.load(active.ledger.file).catch(() => null) : null;
    if (current) {
      if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
      emitRun({ type: "task", task: taskView(current) });
    }
    emitRun({ type: "error", message: error instanceof Error ? error.message : String(error) });
    emitRun({ type: "status", phase: controller.signal.aborted ? "已停止" : "失败", runId });
  } finally {
    if (controller.signal.aborted && active?.runId === runId && active.ledger) {
      const current = await TaskLedger.load(active.ledger.file).catch(() => null);
      if (current?.state.status === "active") await current.stop();
    }
    if (active?.runId === runId) active = null;
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/events") {
      if (request.headers.get("origin") !== `http://127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
      return server.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname.startsWith("/ui")) return serveUi(url.pathname);
    if (url.pathname === "/api/browser/control" && request.method === "GET") return Response.json({ holder: controlHolder });
    if (url.pathname === "/api/tasks" && request.method === "GET") {
      return Response.json({ tasks: (await listTasks()).map(taskSummary), activeTaskId: active?.ledger?.state.id ?? null, activeRunId: active?.runId ?? null });
    }
    if (url.pathname === "/api/tasks/latest" && request.method === "GET") {
      const ledgers = await listTasks();
      return Response.json({ task: ledgers[0] ? taskView(ledgers[0]) : null });
    }
    const getTask = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (getTask && request.method === "GET") {
      const ledger = await loadLedger(getTask[1]);
      return ledger ? Response.json({ task: taskView(ledger) }) : Response.json({ error: "Task not found" }, { status: 404 });
    }
    const screenshot = /^\/api\/tasks\/([0-9a-f-]{36})\/screenshot$/.exec(url.pathname);
    if (screenshot && request.method === "GET") {
      const ledger = await loadLedger(screenshot[1]);
      if (!ledger?.state.preview) return new Response("Not found", { status: 404 });
      const current = Bun.file(join(dataRoot, "evidence", `${ledger.state.id}-${ledger.state.preview.id}-plan.png`));
      const fallback = Bun.file(join(dataRoot, "evidence", `${ledger.state.id}-${ledger.state.preview.id}-narrow.png`));
      const legacy = Bun.file(join(dataRoot, "evidence", `${ledger.state.id}-narrow.png`));
      const image = await current.exists() ? current : await fallback.exists() ? fallback : await legacy.exists() ? legacy : null;
      return image ? new Response(image, { headers: { "content-type": "image/png" } }) : new Response("Not found", { status: 404 });
    }
    if (request.method === "POST" && request.headers.get("origin") && request.headers.get("origin") !== `http://127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/api/tasks" && request.method === "POST") {
      if (active || verification || publishing) return Response.json({ error: "A task is already running" }, { status: 409 });
      const body = await request.json().catch(() => ({})) as { brief?: unknown };
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      if (!brief) return Response.json({ error: "Brief is required" }, { status: 400 });
      const runId = randomUUID();
      const projectRoot = join(productsRoot, runId);
      await mkdir(productsRoot, { recursive: true });
      await cp(join(appRoot, "templates", "web-minimal"), projectRoot, { recursive: true });
      const controller = new AbortController();
      active = { runId, controller };
      void execute(runId, brief, projectRoot, controller);
      return Response.json({ runId, projectRoot });
    }
    const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancel && request.method === "POST") {
      if (active?.runId !== cancel[1]) return Response.json({ error: "Task is not running" }, { status: 404 });
      active.controller.abort();
      return Response.json({ stopping: true });
    }
    if (url.pathname === "/api/browser/control" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { holder?: unknown };
      if (body.holder !== "alpha" && body.holder !== "user") return Response.json({ error: "Invalid browser holder" }, { status: 400 });
      controlHolder = body.holder;
      if (controlHolder === "user") verification?.controller.abort(new Error("User took over the browser"));
      emit({ type: "control", holder: controlHolder });
      return Response.json({ holder: controlHolder });
    }
    const revise = /^\/api\/tasks\/([0-9a-f-]{36})\/revise$/.exec(url.pathname);
    if (revise && request.method === "POST") {
      if (active || verification || publishing) return Response.json({ error: "A task is already running" }, { status: 409 });
      const ledger = await loadLedger(revise[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      const projectRoot = resolve(ledger.state.projectRoot);
      if (!projectRoot.startsWith(productsRoot + sep)) return Response.json({ error: "Task is outside products" }, { status: 403 });
      const body = await request.json().catch(() => ({})) as { brief?: unknown };
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      if (!brief || brief === ledger.state.objective) return Response.json({ error: "A changed task objective is required" }, { status: 400 });
      const previousPreviewId = ledger.state.preview?.id;
      await ledger.reviseObjective(brief);
      if (previousPreviewId) {
        previews.get(previousPreviewId)?.stop();
        previews.delete(previousPreviewId);
      }
      const controller = new AbortController();
      active = { runId: ledger.state.id, controller, ledger };
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      void execute(ledger.state.id, brief, projectRoot, controller, ledger);
      return Response.json({ runId: ledger.state.id, taskId: ledger.state.id, contractVersion: ledger.state.contractVersion });
    }
    const resume = /^\/api\/tasks\/([0-9a-f-]{36})\/resume$/.exec(url.pathname);
    if (resume && request.method === "POST") {
      if (active || verification || publishing) return Response.json({ error: "A task is already running" }, { status: 409 });
      const ledger = await loadLedger(resume[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (ledger.state.status === "complete") return Response.json({ error: "Task is already complete" }, { status: 409 });
      const projectRoot = resolve(ledger.state.projectRoot);
      if (!projectRoot.startsWith(productsRoot + sep)) return Response.json({ error: "Task is outside products" }, { status: 403 });
      const body = await request.json().catch(() => ({})) as { brief?: unknown };
      const correction = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : "Repair the pending acceptance checks while preserving the original objective.";
      if (ledger.state.status === "stopped") await ledger.resume(correction);
      else await ledger.recordGuidance(correction);
      const controller = new AbortController();
      active = { runId: ledger.state.id, controller, ledger };
      void execute(ledger.state.id, correction, projectRoot, controller, ledger);
      return Response.json({ runId: ledger.state.id, taskId: ledger.state.id });
    }
    const publish = /^\/api\/tasks\/([0-9a-f-]{36})\/publish$/.exec(url.pathname);
    if (publish && request.method === "POST") {
      if (active || verification || publishing) return Response.json({ error: "A task is already running" }, { status: 409 });
      publishing = true;
      try {
      const ledger = await loadLedger(publish[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (ledger.state.status === "stopped") return Response.json({ error: "Task is stopped" }, { status: 409 });
      const projectRoot = resolve(ledger.state.projectRoot);
      if (!projectRoot.startsWith(productsRoot + sep)) return Response.json({ error: "Task is outside products" }, { status: 403 });
      const currentPreview = ledger.state.preview;
      if (currentPreview && previews.has(currentPreview.id) && (await fingerprintSource(projectRoot)) === currentPreview.revision) {
        return Response.json(currentPreview);
      }
      if (ledger.state.status === "complete") await ledger.reopen("Local preview was republished and needs browser verification");
      await ledger.refreshRevision();
      const controller = new AbortController();
      if (!(await build(projectRoot, ledger, controller.signal))) return Response.json({ error: "Build failed" }, { status: 422 });
      const instance = await publishPreview(ledger, projectRoot);
      emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: ledger.state.id, pending: ledger.completionGaps() });
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      {
        emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: ledger.state.id, pending: ledger.completionGaps() });
        try {
          await controlledVerification(ledger, controller.signal);
          const verified = await TaskLedger.load(ledger.file);
          emit({ type: "task", taskId: ledger.state.id, task: taskView(verified) });
          emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
          emit({ type: "status", taskId: ledger.state.id, phase: "已验收", runId: ledger.state.id, pending: verified.completionGaps() });
        } catch (error) {
          const current = await TaskLedger.load(ledger.file);
          if (controlHolder === "user") {
            emit({ type: "status", taskId: ledger.state.id, phase: "用户接管", runId: ledger.state.id, pending: current.completionGaps() });
            return Response.json(instance.record);
          }
          if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
          emit({ type: "error", taskId: ledger.state.id, message: `浏览器验收未通过：${error instanceof Error ? error.message : String(error)}` });
          emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: ledger.state.id, pending: current.completionGaps() });
        }
      }
      return Response.json(instance.record);
      } finally {
        publishing = false;
      }
    }
    const verify = /^\/api\/tasks\/([0-9a-f-]{36})\/verify$/.exec(url.pathname);
    if (verify && request.method === "POST") {
      if (active || verification || publishing) return Response.json({ error: "A task is already running" }, { status: 409 });
      const ledger = await loadLedger(verify[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (ledger.state.status !== "active" || !ledger.state.preview || !previews.has(ledger.state.preview.id)) return Response.json({ error: "A live active preview is required" }, { status: 409 });
      try {
        emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: ledger.state.id, pending: ledger.completionGaps() });
        await controlledVerification(ledger, new AbortController().signal);
        const verified = await TaskLedger.load(ledger.file);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(verified) });
        emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
        emit({ type: "status", taskId: ledger.state.id, phase: "已验收", runId: ledger.state.id, pending: verified.completionGaps() });
        return Response.json({ task: taskView(verified) });
      } catch (error) {
        const current = await TaskLedger.load(ledger.file);
        if (controlHolder === "user") {
          emit({ type: "status", taskId: ledger.state.id, phase: "用户接管", runId: ledger.state.id, pending: current.completionGaps() });
          return Response.json({ paused: true, task: taskView(current) }, { status: 202 });
        }
        if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
        emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: ledger.state.id, pending: current.completionGaps() });
        return Response.json({ error: error instanceof Error ? error.message : String(error), task: taskView(current) }, { status: 422 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(socket) { clients.add(socket); },
    close(socket) { clients.delete(socket); },
    message() {},
  },
});

console.log(`ALPHA_SERVER_READY ${server.port}`);
process.on("SIGINT", () => { active?.controller.abort(); for (const preview of previews.values()) preview.stop(); server.stop(true); });
