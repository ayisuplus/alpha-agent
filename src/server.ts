import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { access, cp, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { publishLocalPreview, type PreviewInstance } from "./runtime/local-preview";
import { DEFAULT_MODEL, runTask, type RunEvent } from "./runtime/omp-runner";
import { ModelServiceError, isModelAvailable, listModels, removeApiKey, setApiKey, testModel } from "./runtime/models";
import { TaskLedger, fingerprintSource } from "./runtime/task-ledger";
import { assertGeneratedAssetsIntact } from "./runtime/media-integrity";
import { verifyBrowserPlan } from "./runtime/browser-verifier";
import { TaskActivity, type ActivityKind } from "./runtime/task-activity";
import { readSourceReviews, snapshotSource, writeSourceReview } from "./runtime/source-review";
import { SettingsError, SettingsStore, WorkbenchMeta, isModelSelector, normalizeComfyUrl } from "./runtime/settings";
import { ComfyClient } from "./runtime/comfy-client";
import { cleanupStalePreviews, storageReport } from "./runtime/storage";

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
const settingsStore = new SettingsStore(dataRoot);
const workbenchMeta = new WorkbenchMeta(dataRoot);
let taskMeta = await workbenchMeta.all();
const clients = new Set<ServerWebSocket<unknown>>();
const previews = new Map<string, PreviewInstance>();
let active: { runId: string; controller: AbortController; ledger?: TaskLedger; steer?: (text: string) => Promise<void>; steeringIds: Set<string> } | null = null;
let controlHolder: "alpha" | "user" = "alpha";
let verification: { taskId: string; controller: AbortController } | null = null;
let publishing = false;
let cleaning = false;
const activities = new Map<string, TaskActivity>();
const operations = new Map<string, string>();
const contexts = new Map<string, { contractVersion: number; revision: string | null; previewId: string | null }>();
const textBuffers = new Map<string, string>();
const textTimers = new Map<string, ReturnType<typeof setTimeout>>();

function activityFor(taskId: string): TaskActivity {
  let activity = activities.get(taskId);
  if (!activity) {
    activity = new TaskActivity(dataRoot, taskId);
    activities.set(taskId, activity);
  }
  return activity;
}

function setContext(ledger: TaskLedger): void {
  contexts.set(ledger.state.id, {
    contractVersion: ledger.state.contractVersion ?? 1,
    revision: ledger.state.revision,
    previewId: ledger.state.preview?.id ?? null,
  });
}

type ActivityDetail = { callId?: string; target?: string; intent?: string; error?: boolean };

function appendActivity(taskId: string, kind: ActivityKind, value: string, operationId?: string, detail: ActivityDetail = {}): void {
  const context = contexts.get(taskId);
  const activity = activityFor(taskId);
  const optional = Object.fromEntries(Object.entries(detail).filter(([, item]) => item !== undefined && item !== false)) as ActivityDetail;
  const entry = activity.create({
    operationId: operationId ?? operations.get(taskId) ?? null,
    kind, value, contractVersion: context?.contractVersion ?? 1,
    revision: context?.revision ?? null, previewId: context?.previewId ?? null,
    ...optional,
  });
  // Broadcast before the write so the workbench timeline keeps the same order as the live event stream.
  broadcast({ type: "activity", taskId, entry });
  void activity.write(entry).catch(error => console.error("ALPHA_ACTIVITY_WRITE_FAILED", error));
}

function flushText(taskId: string): void {
  const timer = textTimers.get(taskId);
  if (timer) clearTimeout(timer);
  textTimers.delete(taskId);
  const value = textBuffers.get(taskId);
  textBuffers.delete(taskId);
  if (value) appendActivity(taskId, "text", value);
}

async function loadLedger(id: string): Promise<TaskLedger | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return TaskLedger.load(join(dataRoot, "tasks", `${id}.json`)).catch(() => null);
}

async function safeEvidencePath(path: string): Promise<string | null> {
  const root = await realpath(dataRoot);
  const file = await realpath(path).catch(() => null);
  return file && file.startsWith(root + sep) ? file : null;
}

async function evidenceDetail(ledger: TaskLedger, evidenceId: string): Promise<{ content: string; screenshotUrl: string | null } | null> {
  const item = ledger.state.evidence.find(candidate => candidate.id === evidenceId);
  if (!item) return null;
  const file = await safeEvidencePath(item.source);
  if (!file || ![".json", ".log", ".txt"].includes(extname(file).toLowerCase())) return null;
  const fullContent = await readFile(file, "utf8");
  const content = fullContent.slice(0, 1_000_000);
  let screenshotUrl: string | null = null;
  if (item.kind === "browser" && extname(file).toLowerCase() === ".json" && fullContent.length <= 1_000_000) {
    try {
      const parsed = JSON.parse(fullContent) as { screenshot?: unknown };
      if (typeof parsed.screenshot === "string" && await safeEvidencePath(parsed.screenshot)) screenshotUrl = `/api/tasks/${ledger.state.id}/evidence/${item.id}/screenshot`;
    } catch { /* Preserve readable evidence content even if structured detail is damaged. */ }
  }
  return { content, screenshotUrl };
}

function taskView(ledger: TaskLedger) {
  const preview = ledger.state.preview;
  const evidence = ledger.state.evidence.filter(item => (item.contractVersion ?? 1) === (ledger.state.contractVersion ?? 1) && item.revision === ledger.state.revision && (item.kind !== "browser" || item.previewId === preview?.id));
  const latestEvidence = new Set(ledger.state.criteria.map(criterion => evidence.findLast(item => item.criterionId === criterion.id)?.id));
  return {
    id: ledger.state.id,
    objective: ledger.state.objective,
    originalObjective: ledger.state.contractHistory?.[0]?.objective ?? ledger.state.objective,
    contractVersion: ledger.state.contractVersion ?? 1,
    status: ledger.state.status,
    revision: ledger.state.revision,
    projectRoot: ledger.state.projectRoot,
    modelSelector: ledger.state.modelSelector ?? null,
    meta: taskMeta[ledger.state.id] ?? {},
    running: active?.ledger?.state.id === ledger.state.id,
    acceptsGuidance: active?.ledger?.state.id === ledger.state.id && !!active.steer,
    pending: ledger.completionGaps(),
    criteria: ledger.state.criteria,
    contractHistory: ledger.state.contractHistory ?? [],
    guidanceHistory: ledger.state.guidanceHistory ?? [],
    runs: ledger.state.runs ?? [],
    lastFailure: ledger.state.lastFailure ?? null,
    reopenReason: ledger.state.reopenReason ?? null,
    latestRun: ledger.state.runs?.at(-1) ?? null,
    evidence: ledger.state.evidence.map(item => ({ id: item.id, criterionId: item.criterionId, kind: item.kind, passed: item.passed, source: item.source, recordedAt: item.recordedAt, contractVersion: item.contractVersion ?? 1, revision: item.revision, previewId: item.previewId ?? null, current: latestEvidence.has(item.id) })),
    screenshotUrl: preview && evidence.some(item => item.kind === "browser") ? `/api/tasks/${ledger.state.id}/screenshot` : null,
    preview: preview ? { ...preview, live: previews.has(preview.id) } : null,
    createdAt: ledger.state.createdAt,
    updatedAt: ledger.state.updatedAt,
  };
}

async function listTasks(): Promise<TaskLedger[]> {
  const names = (await readdir(join(dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const ledgers = (await Promise.all(names.map(name => TaskLedger.load(join(dataRoot, "tasks", name)).catch(() => null)))).filter((ledger): ledger is TaskLedger => ledger !== null);
  return ledgers.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
}

async function protectedPreviewIds(): Promise<Set<string>> {
  return new Set([...previews.keys(), ...(await listTasks()).flatMap(task => task.state.preview ? [task.state.preview.id] : [])]);
}

async function diagnostics() {
  const settings = await settingsStore.get();
  const selectedModel = settings.model.default ?? DEFAULT_MODEL;
  const cdpPort = process.env.ALPHA_CDP_PORT;
  const [modelReady, comfyReady, workspaceWritable, productsWritable, browserReady] = await Promise.all([
    isModelAvailable(selectedModel).catch(() => false),
    new ComfyClient(settings.generation.comfyUrl).health(),
    access(dataRoot, constants.W_OK).then(() => true, () => false),
    access(productsRoot, constants.W_OK).then(() => true, () => false),
    cdpPort && /^\d{1,5}$/.test(cdpPort)
      ? fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false)
      : Promise.resolve(false),
  ]);
  const appPackage = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  return {
    paths: { workspace: workspaceRoot, data: dataRoot, products: productsRoot },
    versions: { bun: Bun.version, omp: appPackage.dependencies?.["@oh-my-pi/pi-coding-agent"] ?? "unknown", electron: process.env.ALPHA_ELECTRON_VERSION ?? null },
    checks: [
      { id: "service", label: "Alpha 本机服务", ok: true, detail: "在线" },
      { id: "workspace", label: "运行数据目录", ok: workspaceWritable, detail: dataRoot },
      { id: "products", label: "产品目录", ok: productsWritable, detail: productsRoot },
      { id: "model", label: "默认模型", ok: modelReady, detail: selectedModel },
      { id: "comfy", label: "ComfyUI", ok: comfyReady, detail: settings.generation.comfyUrl },
      { id: "browser", label: "桌面浏览器调试", ok: browserReady, detail: browserReady ? `端口 ${cdpPort}` : "仅桌面端提供" },
    ],
  };
}

function taskSummary(ledger: TaskLedger) {
  return {
    id: ledger.state.id,
    objective: ledger.state.objective,
    originalObjective: ledger.state.contractHistory?.[0]?.objective ?? ledger.state.objective,
    contractVersion: ledger.state.contractVersion ?? 1,
    status: ledger.state.status,
    modelSelector: ledger.state.modelSelector ?? null,
    meta: taskMeta[ledger.state.id] ?? {},
    running: active?.ledger?.state.id === ledger.state.id,
    pendingCount: ledger.completionGaps().length,
    createdAt: ledger.state.createdAt,
    updatedAt: ledger.state.updatedAt,
  };
}

function broadcast(message: unknown): void {
  const data = JSON.stringify(message);
  for (const client of clients) client.send(data);
}

function emit(message: unknown): void {
  const event = message as { type?: string; taskId?: string; runId?: string; value?: string; phase?: string; name?: string; state?: string; message?: string; url?: string; error?: boolean; callId?: string; target?: string; intent?: string; task?: { id: string; contractVersion: number; revision: string | null; preview: { id: string } | null } };
  if (event.type === "task" && event.task) contexts.set(event.task.id, { contractVersion: event.task.contractVersion, revision: event.task.revision, previewId: event.task.preview?.id ?? null });
  if (event.taskId) {
    if (event.type === "text" && event.value) {
      textBuffers.set(event.taskId, (textBuffers.get(event.taskId) ?? "") + event.value);
      if (!textTimers.has(event.taskId)) textTimers.set(event.taskId, setTimeout(() => flushText(event.taskId!), 1_000));
    } else {
      flushText(event.taskId);
      const value = event.type === "status" ? event.phase : event.type === "tool" ? `${event.name} · ${event.state}` : event.type === "error" ? event.message : event.type === "guidance" ? event.value : event.type === "preview" ? `本机预览：${event.url}` : undefined;
      const detail = event.type === "tool" ? { callId: event.callId, target: event.target, intent: event.intent, error: event.error } : undefined;
      if (value && ["status", "tool", "error", "guidance", "preview"].includes(event.type ?? "")) appendActivity(event.taskId, event.type === "preview" ? "status" : event.type as ActivityKind, value, event.runId, detail);
    }
  }
  broadcast(message);
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
  setContext(ledger);
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

async function deliverGuidance(ledger: TaskLedger, id: string, instruction: string, steer: (text: string) => Promise<void>): Promise<void> {
  if (!active || active.ledger?.state.id !== ledger.state.id || active.steeringIds.has(id)) return;
  active.steeringIds.add(id);
  try {
    await steer(instruction);
    await ledger.setGuidanceStatus(id, "delivered");
    appendActivity(ledger.state.id, "guidance", "补充要求已投递到当前模型会话");
  } finally {
    active?.steeringIds.delete(id);
  }
}

function sessionHooks(runId: string) {
  return {
    async onSessionReady(steer: (text: string) => Promise<void>) {
      if (active?.runId !== runId || !active.ledger) return;
      active.steer = steer;
      emit({ type: "task", taskId: active.ledger.state.id, task: taskView(active.ledger) });
      for (const item of active.ledger.state.guidanceHistory ?? []) {
        if (item.id && item.status === "recorded") await active.ledger.setGuidanceStatus(item.id, "delivered");
      }
    },
    async onSessionEnd(queued: readonly string[], completed: boolean) {
      if (active?.runId !== runId || !active.ledger) return;
      active.steer = undefined;
      if (completed) {
        for (const item of active.ledger.state.guidanceHistory ?? []) {
          if (item.id && item.status === "delivered" && !queued.includes(item.instruction)) await active.ledger.setGuidanceStatus(item.id, "processed");
        }
      }
      emit({ type: "task", taskId: active.ledger.state.id, task: taskView(active.ledger) });
    },
  };
}

/** Run options taken from the workbench settings; read when each operation starts, so changes apply to the next run. */
async function configuredRun(taskModel?: string) {
  const settings = await settingsStore.get();
  return {
    // A task keeps its own model; otherwise it follows the workbench default, then Alpha's built-in default.
    modelSelector: taskModel ?? settings.model.default ?? DEFAULT_MODEL,
    maxToolCalls: settings.budget.maxToolCalls,
    wallTimeMs: settings.budget.wallTimeMinutes * 60_000,
    comfyUrl: settings.generation.comfyUrl,
    generation: { image: settings.generation.image, voice: settings.generation.voice, video: settings.generation.video },
  };
}

async function execute(runId: string, objective: string, projectRoot: string, controller: AbortController, existingLedger?: TaskLedger, newTaskModel?: string): Promise<void> {
  let beforeSource: Awaited<ReturnType<typeof snapshotSource>> | null = null;
  const emitRun = (message: Record<string, unknown>) => emit({ ...message, taskId: active?.runId === runId ? active.ledger?.state.id : existingLedger?.state.id });
  try {
    const configured = await configuredRun(existingLedger?.state.modelSelector ?? newTaskModel);
    beforeSource = await snapshotSource(projectRoot);
    emitRun({ type: "status", phase: "构建中", runId });
    const forwardEvent = (event: RunEvent) => {
      if (event.type === "text") emitRun({ type: "text", value: event.value });
      else emitRun({ type: "tool", name: event.value, state: event.type === "tool-start" ? "开始" : "结束", error: event.error, callId: event.callId, target: event.target, intent: event.intent });
    };
    const ledger = await runTask({
      ...configured,
      taskModel: newTaskModel,
      projectRoot, objective, dataRoot, signal: controller.signal, existingLedger,
      onEvent: forwardEvent,
      onLedger(created) {
        if (active?.runId === runId) active.ledger = created;
        setContext(created);
        operations.set(created.state.id, runId);
        if (!existingLedger) appendActivity(created.state.id, "status", "任务已创建", runId);
        emitRun({ type: "task", task: taskView(created) });
      },
      ...sessionHooks(runId),
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
            ...await configuredRun(current.state.modelSelector),
            projectRoot, dataRoot, signal: controller.signal, existingLedger: current,
            objective: `Visible browser acceptance failed: ${reason}. Read the failure evidence and inspect the exact failing step. Decide whether the product or the verification plan is wrong; preserve the original requirements and do not change product code to fix an invalid test selector. Then rebuild.`,
            onEvent: forwardEvent,
            onLedger(created) { if (active?.runId === runId) active.ledger = created; setContext(created); },
            ...sessionHooks(runId),
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
    const ledger = active?.runId === runId ? active.ledger : existingLedger;
    if (beforeSource && ledger) {
      try {
        await writeSourceReview(dataRoot, { taskId: ledger.state.id, operationId: runId, contractVersion: ledger.state.contractVersion ?? 1, revision: ledger.state.revision, before: beforeSource, after: await snapshotSource(projectRoot) });
      } catch (error) { console.error("ALPHA_SOURCE_REVIEW_FAILED", error); }
    }
    if (ledger) { flushText(ledger.state.id); operations.delete(ledger.state.id); }
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
    const activity = /^\/api\/tasks\/([0-9a-f-]{36})\/activity$/.exec(url.pathname);
    if (activity && request.method === "GET") {
      const ledger = await loadLedger(activity[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      flushText(ledger.state.id);
      return Response.json({ entries: await activityFor(ledger.state.id).read() });
    }
    const reviews = /^\/api\/tasks\/([0-9a-f-]{36})\/reviews$/.exec(url.pathname);
    if (reviews && request.method === "GET") {
      const ledger = await loadLedger(reviews[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      return Response.json({ reviews: (await readSourceReviews(dataRoot, ledger.state.id)).map(item => ({ operationId: item.operationId, contractVersion: item.contractVersion, revision: item.revision, recordedAt: item.recordedAt, paths: item.changes.map(change => change.path) })) });
    }
    const review = /^\/api\/tasks\/([0-9a-f-]{36})\/reviews\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (review && request.method === "GET") {
      const ledger = await loadLedger(review[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      const selected = (await readSourceReviews(dataRoot, ledger.state.id)).find(item => item.operationId === review[2]);
      return selected ? Response.json({ review: selected }) : Response.json({ error: "Review not found" }, { status: 404 });
    }
    const evidence = /^\/api\/tasks\/([0-9a-f-]{36})\/evidence\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (evidence && request.method === "GET") {
      const ledger = await loadLedger(evidence[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      const detail = await evidenceDetail(ledger, evidence[2]);
      return detail ? Response.json(detail) : Response.json({ error: "Evidence unavailable" }, { status: 404 });
    }
    const evidenceImage = /^\/api\/tasks\/([0-9a-f-]{36})\/evidence\/([0-9a-f-]{36})\/screenshot$/.exec(url.pathname);
    if (evidenceImage && request.method === "GET") {
      const ledger = await loadLedger(evidenceImage[1]);
      const item = ledger?.state.evidence.find(candidate => candidate.id === evidenceImage[2] && candidate.kind === "browser");
      if (!item) return new Response("Not found", { status: 404 });
      const file = await safeEvidencePath(item.source);
      if (!file || extname(file).toLowerCase() !== ".json") return new Response("Not found", { status: 404 });
      const detail = JSON.parse(await readFile(file, "utf8")) as { screenshot?: unknown };
      const screenshot = typeof detail.screenshot === "string" ? await safeEvidencePath(detail.screenshot) : null;
      return screenshot && extname(screenshot).toLowerCase() === ".png" ? new Response(Bun.file(screenshot), { headers: { "content-type": "image/png" } }) : new Response("Not found", { status: 404 });
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
    if (url.pathname === "/api/settings" && request.method === "GET") return Response.json({ settings: await settingsStore.get() });
    if (url.pathname === "/api/models" && request.method === "GET") {
      const settings = await settingsStore.get();
      return Response.json({ ...await listModels(), default: settings.model.default, builtin: DEFAULT_MODEL });
    }
    if (url.pathname === "/api/diagnostics" && request.method === "GET") return Response.json(await diagnostics());
    if (url.pathname === "/api/storage" && request.method === "GET") return Response.json(await storageReport(dataRoot, productsRoot, await protectedPreviewIds()));
    // Every state-changing request must come from the workbench page itself.
    if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("origin") && request.headers.get("origin") !== `http://127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/api/storage/cleanup-previews" && request.method === "POST") {
      if (active || verification || publishing || cleaning) return Response.json({ error: "请等当前操作结束后再清理预览" }, { status: 409 });
      cleaning = true;
      try { return Response.json(await cleanupStalePreviews(dataRoot, await protectedPreviewIds())); }
      finally { cleaning = false; }
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      try {
        const patch = await request.json().catch(() => null) as { model?: { default?: unknown } } | null;
        const nextDefault = patch?.model?.default;
        if (typeof nextDefault === "string" && isModelSelector(nextDefault) && !(await isModelAvailable(nextDefault))) {
          return Response.json({ error: "这个模型没有可用的认证，不能设为默认" }, { status: 400 });
        }
        const settings = await settingsStore.update(patch);
        broadcast({ type: "settings", settings });
        return Response.json({ settings });
      } catch (error) {
        if (error instanceof SettingsError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    if (url.pathname === "/api/models/test" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { model?: unknown };
      if (!isModelSelector(body.model)) return Response.json({ error: "请选择要测试的模型" }, { status: 400 });
      return Response.json(await testModel(body.model, dataRoot));
    }
    const providerKey = /^\/api\/providers\/([A-Za-z0-9._-]{1,80})\/key$/.exec(url.pathname);
    if (providerKey && (request.method === "PUT" || request.method === "DELETE")) {
      try {
        if (request.method === "DELETE") return Response.json({ removed: await removeApiKey(providerKey[1]) });
        const body = await request.json().catch(() => ({})) as { apiKey?: unknown };
        await setApiKey(providerKey[1], typeof body.apiKey === "string" ? body.apiKey : "");
        return Response.json({ saved: true });
      } catch (error) {
        if (error instanceof ModelServiceError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    const taskModel = /^\/api\/tasks\/([0-9a-f-]{36})\/model$/.exec(url.pathname);
    if (taskModel && request.method === "POST") {
      const ledger = await loadLedger(taskModel[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (active?.ledger?.state.id === ledger.state.id || verification?.taskId === ledger.state.id) return Response.json({ error: "任务运行中，结束后才能更换模型" }, { status: 409 });
      const body = await request.json().catch(() => ({})) as { model?: unknown };
      if (body.model !== null && !isModelSelector(body.model)) return Response.json({ error: "模型格式不正确" }, { status: 400 });
      if (typeof body.model === "string" && !(await isModelAvailable(body.model))) return Response.json({ error: "这个模型没有可用的认证" }, { status: 400 });
      await ledger.setModel(typeof body.model === "string" ? body.model : null);
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      return Response.json({ task: taskView(ledger) });
    }
    const taskMetaRoute = /^\/api\/tasks\/([0-9a-f-]{36})\/meta$/.exec(url.pathname);
    if (taskMetaRoute && request.method === "PATCH") {
      const ledger = await loadLedger(taskMetaRoute[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      const patch = await request.json().catch(() => null) as { archived?: unknown } | null;
      if (patch?.archived === true && (active?.ledger?.state.id === ledger.state.id || verification?.taskId === ledger.state.id)) {
        return Response.json({ error: "运行中的任务不能归档" }, { status: 409 });
      }
      try {
        await workbenchMeta.update(ledger.state.id, patch);
        taskMeta = await workbenchMeta.all();
        const task = taskView(ledger);
        emit({ type: "task", taskId: ledger.state.id, task });
        return Response.json({ task });
      } catch (error) {
        if (error instanceof SettingsError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    if (url.pathname === "/api/generation/check" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { url?: unknown };
      try {
        const comfyUrl = normalizeComfyUrl(typeof body.url === "string" ? body.url : (await settingsStore.get()).generation.comfyUrl);
        return Response.json({ url: comfyUrl, online: await new ComfyClient(comfyUrl).health() });
      } catch (error) {
        if (error instanceof SettingsError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    if (url.pathname === "/api/tasks" && request.method === "POST") {
      if (active || verification || publishing || cleaning) return Response.json({ error: "A task is already running" }, { status: 409 });
      const body = await request.json().catch(() => ({})) as { brief?: unknown; model?: unknown };
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      if (!brief) return Response.json({ error: "Brief is required" }, { status: 400 });
      if (body.model !== undefined && body.model !== null && !isModelSelector(body.model)) return Response.json({ error: "模型格式不正确" }, { status: 400 });
      const chosenModel = typeof body.model === "string" ? body.model : undefined;
      if (chosenModel && !(await isModelAvailable(chosenModel))) return Response.json({ error: "这个模型没有可用的认证" }, { status: 400 });
      const runId = randomUUID();
      const projectRoot = join(productsRoot, runId);
      await mkdir(productsRoot, { recursive: true });
      await cp(join(appRoot, "templates", "web-minimal"), projectRoot, { recursive: true });
      const controller = new AbortController();
      active = { runId, controller, steeringIds: new Set() };
      void execute(runId, brief, projectRoot, controller, undefined, chosenModel);
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
    const guidance = /^\/api\/tasks\/([0-9a-f-]{36})\/guidance$/.exec(url.pathname);
    if (guidance && request.method === "POST") {
      const live = active?.ledger?.state.id === guidance[1] && !!active.steer;
      if ((active || verification || publishing) && !live) return Response.json({ error: "Wait for the current operation to finish before saving guidance" }, { status: 409 });
      const body = await request.json().catch(() => ({})) as { text?: unknown };
      const instruction = typeof body.text === "string" ? body.text.trim() : "";
      if (!instruction) return Response.json({ error: "Guidance is required" }, { status: 400 });
      const ledger = live ? active!.ledger! : await loadLedger(guidance[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (ledger.state.status === "complete") return Response.json({ error: "Revise a completed task before adding guidance" }, { status: 409 });
      setContext(ledger);
      const id = await ledger.recordGuidance(instruction);
      appendActivity(ledger.state.id, "guidance", `补充要求已记录：${instruction}`);
      if (live) {
        try { await deliverGuidance(ledger, id, instruction, active!.steer!); }
        catch (error) { console.error("ALPHA_GUIDANCE_DELIVERY_FAILED", error); }
      }
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      return Response.json({ id, status: ledger.state.guidanceHistory?.find(item => item.id === id)?.status });
    }
    const revise = /^\/api\/tasks\/([0-9a-f-]{36})\/revise$/.exec(url.pathname);
    if (revise && request.method === "POST") {
      if (active || verification || publishing || cleaning) return Response.json({ error: "A task is already running" }, { status: 409 });
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
      const runId = randomUUID();
      active = { runId, controller, ledger, steeringIds: new Set() };
      setContext(ledger);
      operations.set(ledger.state.id, runId);
      appendActivity(ledger.state.id, "status", `目标修订至 v${ledger.state.contractVersion}`, runId);
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      void execute(runId, brief, projectRoot, controller, ledger);
      return Response.json({ runId, taskId: ledger.state.id, contractVersion: ledger.state.contractVersion });
    }
    const resume = /^\/api\/tasks\/([0-9a-f-]{36})\/resume$/.exec(url.pathname);
    if (resume && request.method === "POST") {
      if (active || verification || publishing || cleaning) return Response.json({ error: "A task is already running" }, { status: 409 });
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
      const runId = randomUUID();
      active = { runId, controller, ledger, steeringIds: new Set() };
      setContext(ledger);
      operations.set(ledger.state.id, runId);
      void execute(runId, correction, projectRoot, controller, ledger);
      return Response.json({ runId, taskId: ledger.state.id });
    }
    const publish = /^\/api\/tasks\/([0-9a-f-]{36})\/publish$/.exec(url.pathname);
    if (publish && request.method === "POST") {
      if (active || verification || publishing || cleaning) return Response.json({ error: "A task is already running" }, { status: 409 });
      publishing = true;
      try {
      const ledger = await loadLedger(publish[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      setContext(ledger);
      const publishRunId = randomUUID();
      operations.set(ledger.state.id, publishRunId);
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
      emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: publishRunId, pending: ledger.completionGaps() });
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      {
        emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: publishRunId, pending: ledger.completionGaps() });
        try {
          await controlledVerification(ledger, controller.signal);
          const verified = await TaskLedger.load(ledger.file);
          emit({ type: "task", taskId: ledger.state.id, task: taskView(verified) });
          emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
          emit({ type: "status", taskId: ledger.state.id, phase: "已验收", runId: publishRunId, pending: verified.completionGaps() });
        } catch (error) {
          const current = await TaskLedger.load(ledger.file);
          if (controlHolder === "user") {
            emit({ type: "status", taskId: ledger.state.id, phase: "用户接管", runId: publishRunId, pending: current.completionGaps() });
            return Response.json(instance.record);
          }
          if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
          emit({ type: "error", taskId: ledger.state.id, message: `浏览器验收未通过：${error instanceof Error ? error.message : String(error)}` });
          emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: publishRunId, pending: current.completionGaps() });
        }
      }
      return Response.json(instance.record);
      } finally {
        operations.delete(publish[1]);
        publishing = false;
      }
    }
    const verify = /^\/api\/tasks\/([0-9a-f-]{36})\/verify$/.exec(url.pathname);
    if (verify && request.method === "POST") {
      if (active || verification || publishing || cleaning) return Response.json({ error: "A task is already running" }, { status: 409 });
      const ledger = await loadLedger(verify[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (ledger.state.status !== "active" || !ledger.state.preview || !previews.has(ledger.state.preview.id)) return Response.json({ error: "A live active preview is required" }, { status: 409 });
      setContext(ledger);
      const verifyRunId = randomUUID();
      operations.set(ledger.state.id, verifyRunId);
      try {
        emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: verifyRunId, pending: ledger.completionGaps() });
        await controlledVerification(ledger, new AbortController().signal);
        const verified = await TaskLedger.load(ledger.file);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(verified) });
        emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
        emit({ type: "status", taskId: ledger.state.id, phase: "已验收", runId: verifyRunId, pending: verified.completionGaps() });
        return Response.json({ task: taskView(verified) });
      } catch (error) {
        const current = await TaskLedger.load(ledger.file);
        if (controlHolder === "user") {
          emit({ type: "status", taskId: ledger.state.id, phase: "用户接管", runId: verifyRunId, pending: current.completionGaps() });
          return Response.json({ paused: true, task: taskView(current) }, { status: 202 });
        }
        if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
        emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: verifyRunId, pending: current.completionGaps() });
        return Response.json({ error: error instanceof Error ? error.message : String(error), task: taskView(current) }, { status: 422 });
      } finally {
        operations.delete(ledger.state.id);
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
