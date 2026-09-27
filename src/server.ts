import { createHash, randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { access, cp, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { publishLocalPreview, type PreviewInstance } from "./runtime/local-preview";
import { DEFAULT_MODEL, type RunEvent, type RunOptions } from "./runtime/omp-runner";
import { runDevelopmentWorkflow } from "./runtime/development-workflow";
import { WorkerSupervisor, inspectWorkerAttempt } from "./runtime/worker-supervisor";
import { AgentMailbox } from "./runtime/agent-mailbox";
import { ModelServiceError, isModelAvailable, listModels, removeApiKey, setApiKey, testModel } from "./runtime/models";
import { PromptRefinementError, refinePrompt } from "./runtime/prompt-refinement";
import { TaskLedger, fingerprintSource } from "./runtime/task-ledger";
import { goalStopReason, nextGoalCycle, progressSignature } from "./runtime/goal-continuation";
import { assertGeneratedAssetsIntact } from "./runtime/media-integrity";
import { verifyBrowserPlan } from "./runtime/browser-verifier";
import { TaskActivity, type ActivityKind } from "./runtime/task-activity";
import { readSourceReviews, snapshotSource, snapshotSourceHashes, sourceChanges, writeSourceReview } from "./runtime/source-review";
import { SettingsError, SettingsStore, WorkbenchMeta, isModelSelector, normalizeComfyUrl } from "./runtime/settings";
import { ComfyClient } from "./runtime/comfy-client";
import { SkillPluginError, SkillPluginStore, hashSkillDirectory } from "./plugins/third-party";
import { AgentPresetStore } from "./runtime/agent-presets";
import { cleanupStalePreviews, storageReport } from "./runtime/storage";
import { OperationManager, type OperationLease } from "./runtime/operation-manager";
import { buildChildEnv } from "./runtime/child-env";
import { importCodeWorkspace } from "./runtime/workspace-import";
import { applyCodeChanges, reviewCodeApply } from "./runtime/workspace-apply";
import { acceptCodeChange } from "./runtime/code-acceptance";
import { listResearchSources } from "./runtime/research-source";
import { BrowserBridge } from "./runtime/browser-bridge";
import { BrowserKernel } from "./runtime/browser-kernel";
import { WebPermissionStore } from "./runtime/web-permissions";
import { WebRetrieval, type WebProvider } from "./runtime/web-retrieval";
import { commandApprovalStore } from "./runtime/command-approval";
import { createGeneralWorkspace, verifyGeneralDeliverable, type UploadedInput } from "./runtime/general-work";
import { addTaskInputs } from "./runtime/task-inputs";
import { MCPPermissionStore, type MCPPermission } from "./runtime/mcp-permissions";
import { OperationJournal } from "./runtime/operation-journal";
import { TaskQueueStore } from "./runtime/task-queue";
import { AutomationStore, type AutomationInput } from "./runtime/automations";
import { scopedGitBackup } from "./runtime/scoped-git-backup";
import { ProjectStore } from "./runtime/projects";
import { assertWritablePaths, bindProjectTurn, finalizeProjectTurn, mayWriteProject, prepareProjectTurn, readProjectMemorySnapshot, recoverProjectTurn, unfinishedProjectTurns, type ProjectTurn } from "./runtime/project-state";
import { configuredChecks } from "./runtime/code-check";
import { SandboxUnavailableError, verifySandbox } from "./runtime/sandbox-exec";

const appRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? appRoot);
const dataRoot = join(workspaceRoot, ".alpha");
const productsRoot = join(workspaceRoot, "products");
const directBaselineRoot = join(dataRoot, "direct-baselines");
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
const skillPluginStore = new SkillPluginStore(dataRoot);
const agentPresetStore = new AgentPresetStore(dataRoot);
const workbenchMeta = new WorkbenchMeta(dataRoot);
const commandApprovals = commandApprovalStore(dataRoot);
const mcpPermissions = new MCPPermissionStore(dataRoot);
const browserBridge = process.env.ALPHA_BROWSER_BRIDGE_PORT && process.env.ALPHA_BROWSER_BRIDGE_TOKEN ? new BrowserBridge() : null;
const webKernel = new BrowserKernel(Number(process.env.ALPHA_CDP_PORT) || null, browserBridge);
const webPermissions = new WebPermissionStore(dataRoot);
const webRetrieval = new WebRetrieval(dataRoot, async (provider: WebProvider) => process.env[provider === "tavily" ? "TAVILY_API_KEY" : "FIRECRAWL_API_KEY"] ?? await browserBridge?.key(provider) ?? null);
const operationJournal = new OperationJournal(dataRoot);
const startupReconciliation = await operationJournal.reconcile();
for (const item of startupReconciliation) console.error("ALPHA_RECONCILED_OPERATION", item);
const taskQueue = new TaskQueueStore(dataRoot);
const automationStore = new AutomationStore(dataRoot);
const projectStore = new ProjectStore(dataRoot);
for (const turn of await unfinishedProjectTurns(dataRoot)) {
  if (!turn.taskId) continue;
  const ledger = await TaskLedger.load(join(dataRoot, "tasks", `${turn.taskId}.json`)).catch(() => null);
  if (!ledger) continue;
  try { await recoverProjectTurn(turn, ledger); }
  catch (error) {
    const reason = `项目状态恢复待审阅：${error instanceof Error ? error.message : String(error)}`;
    await ledger.recordCheckpointFailure(reason);
    if (ledger.state.status === "active") await ledger.needInput(reason, "project-state");
    console.error("ALPHA_PROJECT_STATE_RECOVERY", turn.runId, reason);
  }
}
await taskQueue.reconcile();
await automationStore.reconcile();
const queuedRuns = new Map<string, string>();
const automationRuns = new Map<string, string>();
let queueDraining = false;
let automationDraining = false;
let taskMeta = await workbenchMeta.all();
const clients = new Set<ServerWebSocket<unknown>>();
const previews = new Map<string, PreviewInstance>();
let active: { runId: string; controller: AbortController; ledger?: TaskLedger; steer?: (text: string) => Promise<void>; steeringIds: Set<string> } | null = null;
let verification: { taskId: string; controller: AbortController } | null = null;
let publishing = false;
let cleaning = false;
const activities = new Map<string, TaskActivity>();
const operations = new Map<string, string>();
const contexts = new Map<string, { contractVersion: number; revision: string | null; previewId: string | null }>();
const textBuffers = new Map<string, string>();
const textTimers = new Map<string, ReturnType<typeof setTimeout>>();
const operationManager = new OperationManager(operation => broadcast({ type: "operation", operation }));

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

async function taskRootAllowed(ledger: TaskLedger): Promise<boolean> {
  const root = resolve(ledger.state.projectRoot);
  if (ledger.state.projectId) {
    try {
      const roots = await projectStore.roots(ledger.state.projectId, ledger.state.projectVersion ?? 0);
      return ledger.state.workspaceOrigin?.kind === "direct"
        ? roots.some(item => item.toLowerCase() === root.toLowerCase())
        : root === join(productsRoot, `project-${ledger.state.projectId}`);
    } catch (error) {
      if (ledger.state.status === "active") await ledger.needInput(`项目目录已变化，需要重新检查：${error instanceof Error ? error.message : String(error)}`, "project");
      return false;
    }
  }
  return root.startsWith(productsRoot + sep);
}

async function safeEvidencePath(path: string): Promise<string | null> {
  const root = await realpath(dataRoot);
  const file = await realpath(path).catch(() => null);
  return file && file.startsWith(root + sep) ? file : null;
}

async function safeArtifactPath(ledger: TaskLedger, evidenceId: string): Promise<string | null> {
  const item = ledger.state.evidence.find(candidate => candidate.id === evidenceId && candidate.kind === "artifact");
  if (!item?.contentHash) return null;
  const root = await realpath(join(dataRoot, "artifacts", ledger.state.id)).catch(() => null);
  const file = await realpath(item.source).catch(() => null);
  if (!root || !file || !file.startsWith(root + sep)) return null;
  return createHash("sha256").update(await readFile(file)).digest("hex") === item.contentHash ? file : null;
}

async function evidenceDetail(ledger: TaskLedger, evidenceId: string): Promise<{ content: string; screenshotUrl: string | null; artifactUrl?: string } | null> {
  const item = ledger.state.evidence.find(candidate => candidate.id === evidenceId);
  if (!item) return null;
  if (item.kind === "artifact") {
    const file = await safeArtifactPath(ledger, item.id);
    return file ? { content: JSON.stringify({ file, sha256: item.contentHash, sourceIds: item.referenceIds ?? [] }, null, 2), screenshotUrl: null, artifactUrl: `/api/tasks/${ledger.state.id}/artifacts/${item.id}` } : null;
  }
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

function taskView(ledger: TaskLedger, queued = false) {
  const preview = ledger.state.preview;
  const evidence = ledger.state.evidence.filter(item => (item.contractVersion ?? 1) === (ledger.state.contractVersion ?? 1) && item.revision === ledger.state.revision && (item.kind !== "browser" || item.previewId === preview?.id));
  const latestEvidence = new Set(ledger.state.criteria.map(criterion => evidence.findLast(item => item.criterionId === criterion.id)?.id));
  return {
    id: ledger.state.id,
    projectId: ledger.state.projectId ?? null,
    projectVersion: ledger.state.projectVersion ?? null,
    permissionMode: ledger.state.permissionMode ?? null,
    taskType: ledger.state.taskType ?? "web-product",
    workspaceOrigin: ledger.state.workspaceOrigin ?? { kind: "generated" },
    objective: ledger.state.objective,
    designatedExpertId: ledger.state.designatedExpertId ?? null,
    originalObjective: ledger.state.contractHistory?.[0]?.objective ?? ledger.state.objective,
    contractVersion: ledger.state.contractVersion ?? 1,
    status: ledger.state.status,
    phase: ledger.state.phase ?? "execute",
    planApproval: ledger.state.planApproval ?? null,
    goal: ledger.state.goal ?? { enabled: false },
    revision: ledger.state.revision,
    projectRoot: ledger.state.projectRoot,
    inputs: (ledger.state.inputs ?? []).map(item => ({ id: item.id, name: item.name, mimeType: item.mimeType, size: item.size ?? null, sha256: item.sha256, uploadedAt: item.uploadedAt, url: `/api/tasks/${ledger.state.id}/inputs/${item.id}` })),
    capabilities: ledger.state.capabilities ?? null,
    modelSelector: ledger.state.modelSelector ?? null,
    meta: taskMeta[ledger.state.id] ?? {},
    running: active?.ledger?.state.id === ledger.state.id,
    queued,
    acceptsGuidance: active?.ledger?.state.id === ledger.state.id && !!active.steer,
    pending: ledger.completionGaps(),
    pendingCount: ledger.completionGaps().length,
    criteria: ledger.state.criteria,
    contractHistory: ledger.state.contractHistory ?? [],
    guidanceHistory: ledger.state.guidanceHistory ?? [],
    cognition: ledger.state.cognition ?? null,
    development: ledger.state.development ?? null,
    runs: ledger.state.runs ?? [],
    lastFailure: ledger.state.lastFailure ?? null,
    reopenReason: ledger.state.reopenReason ?? null,
    pendingQuestion: ledger.state.pendingQuestion ?? null,
    blockedService: ledger.state.blockedService ?? null,
    checkpoint: ledger.state.checkpoint ?? null,
    checkpointError: ledger.state.checkpointError ?? null,
    checkpointStatus: ledger.state.checkpointStatus ?? (ledger.state.checkpoint ? "committed" : null),
    latestRun: ledger.state.runs?.at(-1) ?? null,
    evidence: ledger.state.evidence.map(item => ({ id: item.id, attemptId: item.attemptId ?? null, criterionId: item.criterionId, kind: item.kind, passed: item.passed, source: item.source, contentHash: item.contentHash ?? null, referenceIds: item.referenceIds ?? [], recordedAt: item.recordedAt, contractVersion: item.contractVersion ?? 1, revision: item.revision, previewId: item.previewId ?? null, current: latestEvidence.has(item.id) })),
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

async function pauseTasksForProjectChange(projectId: string, version: number): Promise<void> {
  for (const ledger of await listTasks()) {
    if (ledger.state.projectId !== projectId || (ledger.state.projectVersion ?? 0) >= version || ledger.state.status !== "active") continue;
    await ledger.needInput("项目目录范围已变化，请重新检查后继续", "project");
    emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
  }
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

function taskSummary(ledger: TaskLedger, queued = false) {
  return {
    id: ledger.state.id,
    projectId: ledger.state.projectId ?? null,
    projectVersion: ledger.state.projectVersion ?? null,
    permissionMode: ledger.state.permissionMode ?? null,
    taskType: ledger.state.taskType ?? "web-product",
    workspaceOrigin: ledger.state.workspaceOrigin ?? { kind: "generated" },
    objective: ledger.state.objective,
    originalObjective: ledger.state.contractHistory?.[0]?.objective ?? ledger.state.objective,
    contractVersion: ledger.state.contractVersion ?? 1,
    status: ledger.state.status,
    phase: ledger.state.phase ?? "execute",
    goal: ledger.state.goal ?? { enabled: false },
    modelSelector: ledger.state.modelSelector ?? null,
    meta: taskMeta[ledger.state.id] ?? {},
    running: active?.ledger?.state.id === ledger.state.id,
    queued,
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
  const operation = operationManager.snapshot();
  if (event.type === "status" && event.phase && operation && (!event.taskId || operation.taskId === event.taskId)) {
    operationManager.update({ id: operation.id }, { phase: event.phase });
  }
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
  signal.throwIfAborted();
  await assertGeneratedAssetsIntact(projectRoot, dataRoot);
  const child = Bun.spawn([process.execPath, "run", "build"], { cwd: projectRoot, env: buildChildEnv(), stdout: "pipe", stderr: "pipe" });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const log = `command=${process.execPath} run build\ncwd=${projectRoot}\nexit=${exitCode}\n${stdout}\n${stderr}`;
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
    await verifyBrowserPlan(ledger, Number(cdpPort), dataRoot, signal, webKernel, false);
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

async function controlledVerification(ledger: TaskLedger, signal: AbortSignal, lease: OperationLease): Promise<void> {
  if (webKernel.controlHolder !== "alpha") throw new Error("User controls the visible browser");
  if (verification) throw new Error("Another browser verification is running");
  const controller = new AbortController();
  verification = { taskId: ledger.state.id, controller };
  operationManager.update(lease, { browserTaskId: ledger.state.id, phase: "浏览器验收" });
  try {
    await verifyTaskBrowser(ledger, AbortSignal.any([signal, controller.signal]));
  } finally {
    if (verification?.controller === controller) verification = null;
    operationManager.update(lease, { browserTaskId: null });
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
async function configuredRun(taskModel?: string, ledger?: TaskLedger) {
  const settings = await settingsStore.get();
  const budget = ledger?.state.goal?.enabled ? ledger.state.goal.budget : undefined;
  return {
    // A task keeps its own model; otherwise it follows the workbench default, then Alpha's built-in default.
    modelSelector: taskModel ?? settings.model.default ?? DEFAULT_MODEL,
    maxToolCalls: budget?.maxToolCalls ?? settings.budget.maxToolCalls,
    wallTimeMs: budget?.wallTimeMs ?? settings.budget.wallTimeMinutes * 60_000,
    maxTotalToolCalls: budget?.maxTotalToolCalls ?? settings.budget.maxTotalToolCalls,
    totalWallTimeMs: budget?.totalWallTimeMs ?? settings.budget.totalWallTimeMinutes * 60_000,
    comfyUrl: settings.generation.comfyUrl,
    generation: { image: settings.generation.image, voice: settings.generation.voice, video: settings.generation.video },
    plugins: settings.plugins,
  };
}

function startOptions(mode: unknown, continuation: unknown): { startMode: "plan" | "execute"; continueUntilAccepted: boolean } | null {
  if (mode !== undefined && mode !== "plan" && mode !== "execute") return null;
  if (continuation !== undefined && typeof continuation !== "boolean") return null;
  return { startMode: mode === "plan" ? "plan" : "execute", continueUntilAccepted: continuation === true };
}

async function selectedCapabilities(skillIds: unknown, pluginIds: unknown, direct: boolean): Promise<NonNullable<TaskLedger["state"]["capabilities"]>> {
  if (!Array.isArray(skillIds) || !Array.isArray(pluginIds) || skillIds.length > 20 || pluginIds.length > 20 ||
    !skillIds.every(id => typeof id === "string") || !pluginIds.every(id => typeof id === "string") ||
    new Set(skillIds).size !== skillIds.length || new Set(pluginIds).size !== pluginIds.length) throw new Error("Invalid task capability selection");
  if (direct && pluginIds.length) throw new Error("Direct project Hook/MCP execution is unavailable inside the native sandbox");
  const installed = await skillPluginStore.list();
  const skills = await skillPluginStore.loadSkills(skillIds as string[]);
  return {
    plugins: (pluginIds as string[]).map(id => {
      const plugin = installed.find(item => item.id === id);
      if (!plugin?.enabled || !(plugin.hooksEnabled || plugin.mcpEnabled)) throw new Error(`Plugin is disabled or has no enabled Hook/MCP: ${id}`);
      return { id, revision: plugin.revision };
    }),
    skills: await Promise.all((skillIds as string[]).map(async id => {
      const skill = skills.find(item => item.name === id);
      const plugin = installed.find(item => id.startsWith(`${item.id}:`));
      if (!skill || !plugin?.enabled) throw new Error(`Skill is unavailable: ${id}`);
      return { id, revision: plugin.revision, hash: await hashSkillDirectory(skill.baseDir) };
    })),
  };
}

async function uploadedFiles(items: FormDataEntryValue[]): Promise<UploadedInput[]> {
  return Promise.all(items.map(async item => {
    if (!(item instanceof File)) throw new Error("Input must be a file");
    return { name: item.name, mimeType: item.type, bytes: new Uint8Array(await item.arrayBuffer()) };
  }));
}

async function execute(runId: string, objective: string, projectRoot: string, controller: AbortController, lease: OperationLease, existingLedger?: TaskLedger, newTaskModel?: string, designatedExpertId?: string, launch = { startMode: "execute" as "plan" | "execute", continueUntilAccepted: false }): Promise<void> {
  let beforeSource: Awaited<ReturnType<typeof snapshotSource>> | null = null;
  let beforeHashes: Awaited<ReturnType<typeof snapshotSourceHashes>> | null = null;
  let runError: string | null = null;
  let projectTurn: ProjectTurn | null = null;
  let writingToolObserved = false;
  const emitRun = (message: Record<string, unknown>) => emit({ ...message, taskId: active?.runId === runId ? active.ledger?.state.id : existingLedger?.state.id });
  const modelRun = async (options: RunOptions): Promise<TaskLedger> => {
    const preview = options.existingLedger?.state.preview;
    const port = process.env.ALPHA_CDP_PORT;
    const browser = options.existingLedger?.state.workspaceOrigin?.kind !== "direct" && preview && previews.has(preview.id) && webKernel.controlHolder === "alpha" && port && /^\d+$/.test(port)
      ? await webKernel.connectPreview(options.existingLedger!.state.id, preview.url, controller.signal).catch(() => undefined)
      : undefined;
    if (browser && options.existingLedger) operationManager.update(lease, { browserTaskId: options.existingLedger.state.id });
    try {
      return await runDevelopmentWorkflow({ ...options, browser, webKernel, browserUrl: preview?.url, browserAccess: () => webKernel.controlHolder === "alpha" && operationManager.snapshot()?.id === lease.id });
    } finally {
      if (browser && options.existingLedger) await webKernel.detachPreview(options.existingLedger.state.id);
      operationManager.update(lease, { browserTaskId: null });
    }
  };
  try {
    if (existingLedger?.state.projectId) {
      try { await projectStore.roots(existingLedger.state.projectId, existingLedger.state.projectVersion ?? 0); }
      catch (error) {
        if (existingLedger.state.status === "active") await existingLedger.needInput(`项目目录已变化，需要重新检查：${error instanceof Error ? error.message : String(error)}`, "project");
        throw error;
      }
    }
    if (existingLedger?.state.workspaceOrigin?.kind === "direct" && existingLedger.state.projectId) {
      const roots = await projectStore.roots(existingLedger.state.projectId, existingLedger.state.projectVersion ?? 0);
      await verifySandbox({ cwd: projectRoot, roots, dataRoot, network: existingLedger.state.permissionMode === "full", signal: controller.signal });
    }
    projectTurn = await prepareProjectTurn({ dataRoot, projectRoot, runId, ledger: existingLedger });
    const configured = await configuredRun(existingLedger?.state.modelSelector ?? newTaskModel, existingLedger);
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
    const cycleOptions = currentLedger ? await configuredRun(currentLedger.state.modelSelector, currentLedger) : configured;
    const ledger = await modelRun({
      ...cycleOptions,
      taskModel: newTaskModel,
      designatedExpertId,
      startMode: launch.startMode,
      continueUntilAccepted: launch.continueUntilAccepted,
      projectRoot, objective: currentInstruction, dataRoot, signal: controller.signal, existingLedger: currentLedger,
      onNeedsInput: reason => controller.abort(new Error(reason)),
      onEvent: forwardEvent,
      onWorkerState: changed => emitRun({ type: "task", task: taskView(changed) }),
      async onLedger(created) {
        if (projectTurn) await bindProjectTurn(projectTurn, created);
        await operationJournal.start(created.state.id, runId);
        if (active?.runId === runId) active.ledger = created;
        operationManager.update(lease, { taskId: created.state.id });
        setContext(created);
        operations.set(created.state.id, runId);
        if (!currentLedger) appendActivity(created.state.id, "status", "任务已创建", runId);
        emitRun({ type: "task", task: taskView(created) });
      },
      ...sessionHooks(runId),
    });
    const verifyCycle = async (): Promise<TaskLedger> => {
    if (active?.runId === runId) active.ledger = ledger;
    emitRun({ type: "task", task: taskView(ledger) });
    if (controller.signal.aborted) {
      emitRun({ type: "status", phase: "已停止", runId, pending: ledger.completionGaps() });
      return ledger;
    }
    if (ledger.state.phase === "plan") {
      try { await ledger.submitPlanForReview(); emitRun({ type: "status", phase: "计划待审阅", runId }); }
      catch (error) { await ledger.recordFailure(error instanceof Error ? error.message : String(error)); emitRun({ type: "status", phase: "继续规划", runId }); }
      emitRun({ type: "task", task: taskView(ledger) });
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
    if (ledger.state.taskType === "general") {
      const fileChanges = sourceChanges(beforeHashes ?? {}, await snapshotSourceHashes(projectRoot));
      const changed = fileChanges.map(item => item.path);
      const hasManifest = await Bun.file(join(projectRoot, "alpha-deliverable.json")).exists() &&
        (changed.some(path => path === "alpha-deliverable.json" || path.startsWith("outputs/")) || ledger.state.criteria.some(item => item.id === "deliverable"));
      const hasWebPlan = await Bun.file(join(projectRoot, "alpha-verification.json")).exists() &&
        (changed.some(path => path !== "alpha-deliverable.json" && !path.startsWith("outputs/")) || ledger.state.criteria.some(item => item.id === "user-path"));
      const codeChanged = changed.some(path => path !== "alpha-deliverable.json" && path !== "alpha-verification.json" && !path.startsWith("outputs/"));
      const scheduledDocuments = automationRuns.has(runId) && ledger.state.workspaceOrigin?.kind === "direct" && fileChanges.length > 0 &&
        fileChanges.every(item => item.after !== null && /\.(?:md|txt|png|jpe?g|webp|svg)$/i.test(item.path));
      const criteria: TaskLedger["state"]["criteria"] = [
        ...(hasManifest ? [{ id: "deliverable", description: "交付文件已核查", kind: "artifact" as const }] : []),
        ...(hasWebPlan ? [{ id: "build", description: "产品构建", kind: "build" as const }, { id: "user-path", description: "浏览器关键路径", kind: "browser" as const }] : []),
        ...(!hasWebPlan && codeChanged ? [{ id: "change", description: scheduledDocuments ? "文档变更可审阅" : "源码变更可审阅", kind: "asset" as const }, ...(scheduledDocuments ? [] : [{ id: "check", description: "项目检查通过", kind: "test" as const }])] : []),
      ];
      await ledger.setCriteria(criteria);
      if (hasManifest) {
        await verifyGeneralDeliverable(ledger, dataRoot, false);
        if (!hasWebPlan && !codeChanged) {
          emitRun({ type: "task", task: taskView(ledger) });
          emitRun({ type: "status", phase: "已验收", runId, pending: [] });
          return ledger;
        }
      }
      if (hasWebPlan) {
        if (ledger.state.workspaceOrigin?.kind === "direct") throw new Error("Direct-project web build is unavailable inside the native sandbox");
      } else {
        if (codeChanged) {
          if (scheduledDocuments) {
            if (projectTurn) assertWritablePaths(projectTurn, changed.map(path => resolve(projectRoot, path)));
            const evidenceRoot = join(dataRoot, "evidence");
            await mkdir(evidenceRoot, { recursive: true });
            const evidencePath = join(evidenceRoot, `${ledger.state.id}-${runId}-document-changes.json`);
            await writeFile(evidencePath, JSON.stringify({ changes: fileChanges }, null, 2), { flag: "wx" });
            await ledger.recordEvidence({ criterionId: "change", kind: "asset", revision: ledger.state.revision!, passed: true, source: evidencePath });
            emitRun({ type: "task", task: taskView(ledger) });
            emitRun({ type: "status", phase: "文档待审阅", runId, pending: ledger.completionGaps() });
            return ledger;
          }
          const accepted = await acceptCodeChange({ ledger, dataRoot, runId, signal: controller.signal, complete: false, onCheck: name => emitRun({ type: "status", phase: `检查 ${name}`, runId }) });
          emitRun({ type: "task", task: taskView(ledger) });
          emitRun({ type: "status", phase: accepted ? "已验收" : "待验收", runId, pending: ledger.completionGaps() });
          return ledger;
        }
        flushText(ledger.state.id);
        const answer = (await activityFor(ledger.state.id).read()).filter(item => item.operationId === runId && item.kind === "text" && item.value.trim()).map(item => item.value).join("\n").trim();
        if (!answer) throw new Error("Task returned without an answer or reviewable output");
        if (/(制作|生成|创建|输出|交付|导出|写一份|做一份).{0,30}(文件|文档|PDF|DOCX|XLSX|CSV|PPT|表格|报告|图片|视频|音频)/i.test(ledger.state.objective)) throw new Error("Requested deliverable is missing");
        if (/(修复|修改|重构|实现|新增|编写|开发).{0,30}(代码|bug|项目|模块|功能|组件)/i.test(ledger.state.objective)) throw new Error("Requested source change is missing");
        if (/(创建|制作|开发|构建).{0,30}(网页|网站|web|页面|应用)/i.test(ledger.state.objective)) throw new Error("Requested web product is missing");
        emitRun({ type: "task", task: taskView(ledger) });
        emitRun({ type: "status", phase: "已验收", runId, pending: [] });
        return ledger;
      }
    }
    if (ledger.state.taskType === "code-change") {
      let accepted = false;
        try { accepted = await acceptCodeChange({ ledger, dataRoot, runId: ledger.state.goal?.enabled ? randomUUID() : runId, signal: controller.signal, complete: false, onCheck: name => emitRun({ type: "status", phase: `检查 ${name}`, runId }) }); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!ledger.state.goal?.enabled || !reason.startsWith("Configured check failed:")) throw error;
        await ledger.recordFailure(reason);
      }
      if (!accepted) {
        emitRun({ type: "status", phase: "待验收", runId, pending: ledger.completionGaps() });
        return ledger;
      }
      emitRun({ type: "task", task: taskView(ledger) });
      emitRun({ type: "status", phase: "已验收", runId, pending: [] });
      return ledger;
    }
    if (ledger.state.taskType === "research" || ledger.state.taskType === "file-work") {
      try { await verifyGeneralDeliverable(ledger, dataRoot, false); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!ledger.state.goal?.enabled || /Input changed|Workspace changed|outside|source unavailable/i.test(reason)) throw error;
        await ledger.recordFailure(reason);
        emitRun({ type: "status", phase: "待验收", runId, pending: ledger.completionGaps() });
        return ledger;
      }
      emitRun({ type: "task", task: taskView(ledger) });
      emitRun({ type: "status", phase: "已验收", runId, pending: [] });
      return ledger;
    }
    emitRun({ type: "status", phase: "验证构建", runId });
    if (!(await build(projectRoot, ledger, controller.signal))) {
      emitRun({ type: "status", phase: controller.signal.aborted ? "已停止" : "失败", runId, pending: ledger.completionGaps() });
      return ledger;
    }
    emitRun({ type: "status", phase: "发布本机预览", runId });
    await publishPreview(ledger, projectRoot);
    {
      for (let attempt = 0; attempt < 2; attempt++) {
        emitRun({ type: "status", phase: "浏览器验收", runId });
        try {
          await controlledVerification(await TaskLedger.load(ledger.file), controller.signal, lease);
          const verified = await TaskLedger.load(ledger.file);
          emitRun({ type: "task", task: taskView(verified) });
          emitRun({ type: "tool", name: "browser", state: "通过" });
          emitRun({ type: "status", phase: verified.completionGaps().length ? "待验收" : "已验收", runId, pending: verified.completionGaps() });
          return verified;
        } catch (error) {
          if (webKernel.controlHolder === "user") {
            emitRun({ type: "status", phase: "用户接管", runId, pending: (await TaskLedger.load(ledger.file)).completionGaps() });
            return await TaskLedger.load(ledger.file);
          }
          const reason = error instanceof Error ? error.message : String(error);
          emitRun({ type: "tool", name: "browser", state: `验收失败：${reason.slice(0, 400)}`, error: true });
          const current = await TaskLedger.load(ledger.file);
          if (current.state.status === "active") await current.recordFailure(reason);
          const latestBrowser = current.state.evidence.findLast(item => item.criterionId === "user-path" && item.previewId === current.state.preview?.id);
          if (controller.signal.aborted || attempt === 1 || (latestBrowser?.passed !== false && !reason.includes("Verification plan"))) break;
          emitRun({ type: "status", phase: "修复中", runId, pending: current.completionGaps() });
          const failedRevision = current.state.revision;
          const repaired = await modelRun({
            ...await configuredRun(current.state.modelSelector, current),
            projectRoot, dataRoot, signal: controller.signal, existingLedger: current,
            objective: `Visible browser acceptance failed: ${reason}. Read the failure evidence and inspect the exact failing step. Decide whether the product or the verification plan is wrong; preserve the original requirements and do not change product code to fix an invalid test selector. Then rebuild.`,
            onEvent: forwardEvent,
            async onLedger(created) { await operationJournal.start(created.state.id, runId); if (active?.runId === runId) active.ledger = created; setContext(created); },
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
    return current;
    };
    const verified = await verifyCycle();
    currentLedger = await TaskLedger.load(verified.file);
    const continuation = nextGoalCycle(currentLedger, beforeProgress, controller.signal.aborted, webKernel.controlHolder === "user");
    if (!continuation.continue && continuation.stopReason !== "no-progress") return;
    if (continuation.stopReason === "no-progress") {
      await currentLedger.recordFailure("Two consecutive goal cycles made no source, deliverable, or verified-evidence progress");
      await currentLedger.setGoalProgress(continuation.noProgressRuns, "no-progress");
      await currentLedger.stop();
      emitRun({ type: "task", task: taskView(currentLedger) });
      emitRun({ type: "status", phase: "无实际进展，已停止", runId, pending: currentLedger.completionGaps() });
      return;
    }
    await currentLedger.setGoalProgress(continuation.noProgressRuns);
    currentInstruction = `Continue the current task toward acceptance. Inspect the latest failed checks and evidence, choose the next justified action, and stop to ask for input if blocked. Pending: ${currentLedger.completionGaps().join(", ")}.`;
    emitRun({ type: "status", phase: "目标继续推进", runId, pending: currentLedger.completionGaps() });
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    const current = active?.runId === runId && active.ledger ? await TaskLedger.load(active.ledger.file).catch(() => null) : null;
    if (current) {
      if (current.state.status === "active") {
        if (error instanceof SandboxUnavailableError) await current.needInput(error.message, "windows-sandbox");
        else if (/^Authenticated model is unavailable:/.test(error instanceof Error ? error.message : String(error))) await current.needInput(error instanceof Error ? error.message : String(error), "model");
        else await current.recordFailure(error instanceof Error ? error.message : String(error));
      }
      emitRun({ type: "task", task: taskView(current) });
    }
    emitRun({ type: "error", message: error instanceof Error ? error.message : String(error) });
    emitRun({ type: "status", phase: current?.state.status === "needs-input" ? "需要回答" : controller.signal.aborted ? "已停止" : "失败", runId });
  } finally {
    const ledger = active?.runId === runId ? active.ledger : existingLedger;
    if (ledger) {
      try {
        const current = await TaskLedger.load(ledger.file);
        const reason = goalStopReason(current, controller.signal.aborted, webKernel.controlHolder === "user", runError);
        if (reason && current.state.goal?.stopReason !== reason) {
          await current.setGoalProgress(current.state.goal?.noProgressRuns ?? 0, reason);
          emitRun({ type: "task", task: taskView(current) });
        }
      } catch (error) { console.error("ALPHA_GOAL_STOP_RECORD_FAILED", error); }
    }
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
    if (projectTurn && ledger) {
      try {
        const current = await TaskLedger.load(ledger.file);
        await finalizeProjectTurn(projectTurn, current, writingToolObserved);
        if (!runError && !controller.signal.aborted && current.state.status === "active" && current.state.phase === "execute" && !current.completionGaps().length) await current.complete();
        emitRun({ type: "task", task: taskView(current) });
      } catch (error) {
        const reason = `项目状态收尾失败：${error instanceof Error ? error.message : String(error)}`;
        runError = runError ?? reason;
        const current = await TaskLedger.load(ledger.file).catch(() => null);
        if (current) await current.recordCheckpointFailure(reason);
        if (current?.state.status === "active") await current.needInput(reason, "project-state");
        if (current) emitRun({ type: "task", task: taskView(current) });
        emitRun({ type: "error", message: reason });
      }
    }
    if (ledger) await operationJournal.finish(ledger.state.id, runId);
    const queueItemId = queuedRuns.get(runId);
    if (queueItemId) {
      queuedRuns.delete(runId);
      await taskQueue.finish(queueItemId, runError ?? (controller.signal.aborted ? "cancelled" : ledger ? `task ${ledger.state.status}; pending ${ledger.completionGaps().join(", ") || "none"}` : "no task ledger"), !runError && !controller.signal.aborted);
    }
    const automationRunId = automationRuns.get(runId);
    if (automationRunId) {
      automationRuns.delete(runId);
      const current = ledger ? await TaskLedger.load(ledger.file).catch(() => null) : null;
      const status = runError || controller.signal.aborted || !current ? "failed" : current.state.status === "complete" ? "complete" : "needs-input";
      await automationStore.finish(automationRunId, status, runError ?? (controller.signal.aborted ? "cancelled" : `task ${current?.state.status ?? "unavailable"}`));
    }
    if (active?.runId === runId) active = null;
    operationManager.release(lease);
    void drainQueue();
    void drainAutomations();
  }
}

async function drainQueue(): Promise<void> {
  if (queueDraining || operationManager.snapshot()) return;
  queueDraining = true;
  let lease: OperationLease | null = null;
  let itemId: string | null = null;
  let launched = false;
  try {
    const item = await taskQueue.next();
    if (!item) return;
    itemId = item.id;
    lease = operationManager.claim("run", item.taskId);
    if (!lease) return;
    const ledger = await loadLedger(item.taskId);
    if (!ledger) throw new Error("Queued task no longer exists");
    const projectRoot = resolve(ledger.state.projectRoot);
    if (!await taskRootAllowed(ledger)) throw new Error("Queued task workspace is unavailable");
    if (ledger.state.status === "complete") await ledger.reviseObjective(item.instruction);
    else if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(item.instruction);
    else await ledger.recordGuidance(item.instruction);
    const runId = randomUUID();
    await taskQueue.start(item.id, runId);
    queuedRuns.set(runId, item.id);
    active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
    setContext(ledger);
    operations.set(ledger.state.id, runId);
    emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
    launched = true;
    void execute(runId, item.instruction, projectRoot, lease.controller, lease, ledger);
  } catch (error) {
    if (itemId) await taskQueue.finish(itemId, error instanceof Error ? error.message : String(error), false);
  } finally {
    if (!launched && lease) operationManager.release(lease);
    queueDraining = false;
  }
}

async function drainAutomations(): Promise<void> {
  if (automationDraining || operationManager.snapshot()) return;
  automationDraining = true;
  let lease: OperationLease | null = null;
  let pendingId: string | null = null;
  let launched = false;
  let handledSynchronously = false;
  try {
    const pending = await automationStore.next();
    if (!pending) return;
    pendingId = pending.id;
    const automation = (await automationStore.list()).automations.find(item => item.id === pending.automationId);
    if (!automation || automation.status !== "ACTIVE") throw new Error("Automation is no longer active");
    lease = operationManager.claim("run", automation.targetTaskId ?? null);
    if (!lease) return;
    if (automation.modelSelector && !await isModelAvailable(automation.modelSelector)) throw new Error("Automation model is unavailable");
    if (automation.executor === "scoped-git-backup") {
      const project = await projectStore.get(automation.projectId!);
      const mount = project?.mounts.find(item => item.id === automation.mountId);
      if (!project || !mount || project.permissionMode !== "full") throw new Error("Scoped backup project is unavailable or lacks full access");
      await verifySandbox({ cwd: mount.path, roots: await projectStore.roots(project.id, project.version), dataRoot, network: true, signal: lease.controller.signal });
      const ledger = await TaskLedger.create(dataRoot, { objective: automation.prompt, projectRoot: mount.path, taskType: "general", criteria: [],
        workspaceOrigin: { kind: "direct" }, projectId: project.id, projectVersion: project.version, permissionMode: "full" });
      operationManager.update(lease, { taskId: ledger.state.id });
      await automationStore.start(pending.id, ledger.state.id, randomUUID());
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      try {
        const result = await scopedGitBackup(mount.path, lease.controller.signal);
        await ledger.complete();
        await automationStore.finish(pending.id, "complete", result.message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await ledger.needInput(reason, "git-backup");
        await automationStore.finish(pending.id, "needs-input", reason);
      }
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      handledSynchronously = true;
      return;
    }
    let ledger: TaskLedger;
    if (automation.kind === "heartbeat") {
      const target = await loadLedger(automation.targetTaskId!);
      if (!target || !await taskRootAllowed(target)) throw new Error("Automation target task is unavailable");
      ledger = target;
      if (ledger.state.status === "complete") await ledger.reviseObjective(automation.prompt);
      else if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(automation.prompt);
      else await ledger.recordGuidance(automation.prompt);
      if (automation.modelSelector) await ledger.setModel(automation.modelSelector);
    } else if (automation.projectId) {
      const project = await projectStore.get(automation.projectId);
      if (!project) throw new Error("Automation project no longer exists");
      const mount = project.mounts.find(item => item.id === automation.mountId);
      if (project.mounts.length && !mount) throw new Error("Automation working directory is unavailable");
      const projectRoot = mount?.path ?? join(productsRoot, `project-${project.id}`);
      if (!mount) await mkdir(projectRoot, { recursive: true });
      if (mount) await verifySandbox({ cwd: mount.path, roots: await projectStore.roots(project.id, project.version), dataRoot, network: project.permissionMode === "full", signal: lease.controller.signal });
      ledger = await TaskLedger.create(dataRoot, { objective: automation.prompt, projectRoot, taskType: "general", criteria: [],
        workspaceOrigin: { kind: mount ? "direct" : "generated", ...(mount ? { checks: await configuredChecks(mount.path) } : {}) },
        projectId: project.id, projectVersion: project.version, permissionMode: project.permissionMode ?? "ask", modelSelector: automation.modelSelector ?? undefined });
      if (mount) {
        const baseline = await snapshotSourceHashes(projectRoot);
        await mkdir(directBaselineRoot, { recursive: true });
        await writeFile(join(directBaselineRoot, `${ledger.state.id}.json`), JSON.stringify({ format: 2, files: baseline }), { flag: "wx" });
      }
    } else {
      ledger = await createGeneralWorkspace({ taskType: "general", objective: automation.prompt, productsRoot, dataRoot, modelSelector: automation.modelSelector ?? undefined });
    }
    operationManager.update(lease, { taskId: ledger.state.id });
    const runId = randomUUID();
    await automationStore.start(pending.id, ledger.state.id, runId);
    automationRuns.set(runId, pending.id);
    active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
    setContext(ledger);
    operations.set(ledger.state.id, runId);
    emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
    launched = true;
    void execute(runId, automation.prompt, ledger.state.projectRoot, lease.controller, lease, ledger);
  } catch (error) {
    if (pendingId) await automationStore.finish(pendingId, "failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (!launched && lease) operationManager.release(lease);
    automationDraining = false;
    if (handledSynchronously) void drainAutomations();
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url);
    // Check every mutating route before dispatch, including queue and worker controls.
    if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("origin") && request.headers.get("origin") !== `http://127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/events") {
      if (request.headers.get("origin") !== `http://127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
      return server.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname.startsWith("/ui")) return serveUi(url.pathname);
    if (url.pathname === "/api/browser/control" && request.method === "GET") return Response.json({ holder: webKernel.controlHolder });
    if (url.pathname === "/api/tasks" && request.method === "GET") {
      const queued = new Set((await taskQueue.all()).items.filter(item => item.status === "pending").map(item => item.taskId));
      return Response.json({ tasks: (await listTasks()).map(ledger => taskSummary(ledger, queued.has(ledger.state.id))), activeTaskId: active?.ledger?.state.id ?? null, activeRunId: active?.runId ?? null, operation: operationManager.snapshot() });
    }
    if (url.pathname === "/api/queue" && request.method === "GET") return Response.json(await taskQueue.all());
    if (url.pathname === "/api/automations" && request.method === "GET") return Response.json(await automationStore.list());
    if (url.pathname === "/api/automations" && request.method === "POST") {
      try {
        const body = await request.json() as AutomationInput;
        if (body.kind === "heartbeat" && !await loadLedger(body.targetTaskId ?? "")) throw new Error("Automation target task is unavailable");
        if (body.kind === "cron" && body.projectId) {
          const project = await projectStore.get(body.projectId);
          if (!project || project.mounts.length && !project.mounts.some(item => item.id === body.mountId)) throw new Error("Automation project or working directory is unavailable");
        }
        if (body.modelSelector && !await isModelAvailable(body.modelSelector)) throw new Error("Automation model is unavailable");
        return Response.json({ automation: await automationStore.create(body) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const automationRoute = /^\/api\/automations\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (automationRoute && (request.method === "PATCH" || request.method === "DELETE")) {
      try {
        if (request.method === "DELETE") { await automationStore.delete(automationRoute[1]); return Response.json({ deleted: true }); }
        const patch = await request.json() as Partial<AutomationInput> & { status?: "ACTIVE" | "PAUSED" };
        if (patch.targetTaskId && !await loadLedger(patch.targetTaskId)) throw new Error("Automation target task is unavailable");
        if (patch.modelSelector && !await isModelAvailable(patch.modelSelector)) throw new Error("Automation model is unavailable");
        return Response.json({ automation: await automationStore.update(automationRoute[1], patch) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const automationNow = /^\/api\/automations\/([0-9a-f-]{36})\/run$/.exec(url.pathname);
    if (automationNow && request.method === "POST") {
      try { const run = await automationStore.runNow(automationNow[1]); void drainAutomations(); return Response.json({ run }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const automationRead = /^\/api\/automation-runs\/([0-9a-f-]{36})\/read$/.exec(url.pathname);
    if (automationRead && request.method === "POST") {
      try { await automationStore.markRead(automationRead[1]); return Response.json({ read: true }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    if (url.pathname === "/api/queue" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { taskId?: unknown; instruction?: unknown };
      if (typeof body.taskId !== "string" || !await loadLedger(body.taskId) || typeof body.instruction !== "string") return Response.json({ error: "Queue task or instruction is invalid" }, { status: 400 });
      const item = await taskQueue.enqueue(body.taskId, body.instruction);
      void drainQueue();
      return Response.json({ item });
    }
    const queueCancel = /^\/api\/queue\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (queueCancel && request.method === "DELETE") { await taskQueue.cancel(queueCancel[1]); return Response.json({ cancelled: true }); }
    if (url.pathname === "/api/schedules" && request.method === "GET") return Response.json(await taskQueue.all());
    if (url.pathname === "/api/schedules" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { taskId?: unknown; instruction?: unknown; nextRunAt?: unknown; intervalMinutes?: unknown };
      if (typeof body.taskId !== "string" || !await loadLedger(body.taskId) || typeof body.instruction !== "string" || typeof body.nextRunAt !== "string" || body.intervalMinutes !== null && typeof body.intervalMinutes !== "number") return Response.json({ error: "Schedule fields are invalid" }, { status: 400 });
      const schedule = await taskQueue.schedule(body.taskId, body.instruction, body.nextRunAt, body.intervalMinutes as number | null);
      return Response.json({ schedule });
    }
    const scheduleDelete = /^\/api\/schedules\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (scheduleDelete && request.method === "DELETE") { await taskQueue.disable(scheduleDelete[1]); return Response.json({ disabled: true }); }
    if (url.pathname === "/api/tasks/latest" && request.method === "GET") {
      const ledgers = await listTasks();
      const queued = new Set((await taskQueue.all()).items.filter(item => item.status === "pending").map(item => item.taskId));
      return Response.json({ task: ledgers[0] ? taskView(ledgers[0], queued.has(ledgers[0].state.id)) : null });
    }
    const taskMemory = /^\/api\/tasks\/([0-9a-f-]{36})\/memory$/.exec(url.pathname);
    if (taskMemory && request.method === "GET") {
      const ledger = await loadLedger(taskMemory[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      return Response.json({ ...await readProjectMemorySnapshot(dataRoot, ledger.state.projectRoot, ledger), checkpoint: ledger.state.checkpoint ?? null, error: ledger.state.checkpointError ?? null });
    }
    const getTask = /^\/api\/tasks\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (getTask && request.method === "GET") {
      const ledger = await loadLedger(getTask[1]);
      const queued = ledger && (await taskQueue.all()).items.some(item => item.taskId === ledger.state.id && item.status === "pending");
      return ledger ? Response.json({ task: taskView(ledger, !!queued) }) : Response.json({ error: "Task not found" }, { status: 404 });
    }
    const workerDetail = /^\/api\/tasks\/([0-9a-f-]{36})\/workers\/([0-9a-f-]{36})$/.exec(url.pathname);
    const agentMessages = /^\/api\/tasks\/([0-9a-f-]{36})\/agents\/messages$/.exec(url.pathname);
    if (agentMessages && request.method === "GET") {
      const ledger = await loadLedger(agentMessages[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      const mailbox = new AgentMailbox(dataRoot, ledger);
      await mailbox.collect();
      return Response.json({ messages: await mailbox.inbox() });
    }
    if (workerDetail && request.method === "GET") {
      const ledger = await loadLedger(workerDetail[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      try { return Response.json(await inspectWorkerAttempt(ledger, dataRoot, workerDetail[2])); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 }); }
    }
    const workerCancel = /^\/api\/tasks\/([0-9a-f-]{36})\/workers\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname);
    if (workerCancel && request.method === "POST") {
      const supervisor = WorkerSupervisor.forTask(workerCancel[1]);
      if (!supervisor) {
        const ledger = await loadLedger(workerCancel[1]);
        const instance = ledger?.state.cognition?.instances?.find(item => item.id === workerCancel[2]);
        if (!ledger || instance?.status !== "returned" || operationManager.snapshot()?.taskId === workerCancel[1]) return Response.json({ error: "Worker is not active in this runtime" }, { status: 409 });
        await ledger.updateWorker(workerCancel[2], "cancelled", { findings: ["Result discarded by user"] });
        return Response.json({ task: taskView(ledger) });
      }
      try { await supervisor.cancel(workerCancel[2]); return Response.json({ task: taskView(supervisor.ledger) }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
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
    const taskInput = /^\/api\/tasks\/([0-9a-f-]{36})\/inputs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (taskInput && request.method === "GET") {
      const ledger = await loadLedger(taskInput[1]);
      const item = ledger?.state.inputs?.find(input => input.id === taskInput[2]);
      if (!item) return new Response("Not found", { status: 404 });
      const path = await realpath(item.path).catch(() => null);
      const allowed = [join(dataRoot, "task-inputs", ledger!.state.id), join(ledger!.state.projectRoot, "inputs")];
      if (!path || !allowed.some(root => path.startsWith(root + sep))) return new Response("Not found", { status: 404 });
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) return new Response("Input changed", { status: 409 });
      return new Response(bytes, { headers: { "content-type": item.mimeType || "application/octet-stream", "content-disposition": `attachment; filename="${encodeURIComponent(item.name)}"` } });
    }
    const artifact = /^\/api\/tasks\/([0-9a-f-]{36})\/artifacts\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (artifact && request.method === "GET") {
      const ledger = await loadLedger(artifact[1]);
      const file = ledger ? await safeArtifactPath(ledger, artifact[2]) : null;
      if (!file) return new Response("Not found", { status: 404 });
      const type = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[extname(file).toLowerCase()] ?? "application/octet-stream";
      const disposition = url.searchParams.get("inline") === "1" && ["application/pdf", "image/png", "image/jpeg", "text/plain; charset=utf-8"].includes(type) ? "inline" : "attachment";
      return new Response(Bun.file(file), { headers: { "content-type": type, "content-disposition": `${disposition}; filename="${encodeURIComponent(file.split(sep).at(-1) ?? "artifact")}"` } });
    }
    const screenshot = /^\/api\/tasks\/([0-9a-f-]{36})\/screenshot$/.exec(url.pathname);
    if (screenshot && request.method === "GET") {
      const ledger = await loadLedger(screenshot[1]);
      if (!ledger?.state.preview) return new Response("Not found", { status: 404 });
      const latest = ledger.state.evidence.findLast(item => item.kind === "browser" && item.previewId === ledger.state.preview?.id);
      if (latest) {
        const file = await safeEvidencePath(latest.source);
        if (file) {
          const detail = JSON.parse(await readFile(file, "utf8")) as { screenshot?: unknown };
          const imagePath = typeof detail.screenshot === "string" ? await safeEvidencePath(detail.screenshot) : null;
          if (imagePath && extname(imagePath).toLowerCase() === ".png") return new Response(Bun.file(imagePath), { headers: { "content-type": "image/png" } });
        }
      }
      const current = Bun.file(join(dataRoot, "evidence", `${ledger.state.id}-${ledger.state.preview.id}-plan.png`));
      const fallback = Bun.file(join(dataRoot, "evidence", `${ledger.state.id}-${ledger.state.preview.id}-narrow.png`));
      const legacy = Bun.file(join(dataRoot, "evidence", `${ledger.state.id}-narrow.png`));
      const image = await current.exists() ? current : await fallback.exists() ? fallback : await legacy.exists() ? legacy : null;
      return image ? new Response(image, { headers: { "content-type": "image/png" } }) : new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/api/settings" && request.method === "GET") return Response.json({ settings: await settingsStore.get() });
    if (url.pathname === "/api/agent-presets" && request.method === "GET") {
      const presets = (await agentPresetStore.list()).map(({ instructions: _instructions, ...item }) => item);
      return Response.json({ presets });
    }
    if (url.pathname === "/api/agent-presets/templates" && request.method === "GET") {
      return Response.json({ presets: (await agentPresetStore.templates()).map(({ instructions: _instructions, ...item }) => item) });
    }
    const presetDetail = /^\/api\/agent-presets\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (presetDetail && request.method === "GET") {
      try { return Response.json({ preset: await agentPresetStore.get(presetDetail[1]) }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 }); }
    }
    if (url.pathname === "/api/plugins" && request.method === "GET") return Response.json({ plugins: await skillPluginStore.list() });
    if (url.pathname === "/api/capabilities" && request.method === "GET") {
      const [plugins, skills] = await Promise.all([skillPluginStore.list(), skillPluginStore.loadSkills()]);
      return Response.json({ plugins, skills: skills.map(item => ({ id: item.name, name: item.name.split(":").at(-1), description: item.description })) });
    }
    if (url.pathname === "/api/models" && request.method === "GET") {
      const settings = await settingsStore.get();
      return Response.json({ ...await listModels(), default: settings.model.default, builtin: DEFAULT_MODEL });
    }
    if (url.pathname === "/api/web/providers" && request.method === "GET") {
      const providers = await Promise.all((["tavily", "firecrawl"] as const).map(async provider => ({ id: provider, configured: !!(process.env[provider === "tavily" ? "TAVILY_API_KEY" : "FIRECRAWL_API_KEY"] || await browserBridge?.key(provider).catch(() => null)), source: process.env[provider === "tavily" ? "TAVILY_API_KEY" : "FIRECRAWL_API_KEY"] ? "environment" : "desktop" })));
      return Response.json({ providers, desktopBrowser: !!browserBridge });
    }
    const webSources = /^\/api\/tasks\/([0-9a-f-]{36})\/web-sources$/.exec(url.pathname);
    if (webSources && request.method === "GET") {
      if (!await loadLedger(webSources[1])) return Response.json({ error: "Task not found" }, { status: 404 });
      return Response.json({ sources: await listResearchSources(dataRoot, webSources[1]), jobs: await webRetrieval.jobs(webSources[1]) });
    }
    const webApprovals = /^\/api\/tasks\/([0-9a-f-]{36})\/web-approvals$/.exec(url.pathname);
    if (webApprovals && request.method === "GET") {
      if (!await loadLedger(webApprovals[1])) return Response.json({ error: "Task not found" }, { status: 404 });
      return Response.json({ approvals: await webPermissions.list(webApprovals[1]) });
    }
    const webTabs = /^\/api\/tasks\/([0-9a-f-]{36})\/web-tabs$/.exec(url.pathname);
    if (webTabs && request.method === "GET") {
      if (!await loadLedger(webTabs[1])) return Response.json({ error: "Task not found" }, { status: 404 });
      return Response.json({ tabs: await Promise.all(webKernel.tabs(webTabs[1]).map(tab => webKernel.currentTab(webTabs[1], tab.tabId))) });
    }
    if (url.pathname === "/api/diagnostics" && request.method === "GET") return Response.json(await diagnostics());
    if (url.pathname === "/api/storage" && request.method === "GET") return Response.json(await storageReport(dataRoot, productsRoot, await protectedPreviewIds()));
    const webProviderKey = /^\/api\/web\/providers\/(tavily|firecrawl)\/key$/.exec(url.pathname);
    if (webProviderKey && (request.method === "PUT" || request.method === "DELETE")) {
      if (!browserBridge) return Response.json({ error: "Desktop key store is unavailable; configure an environment variable" }, { status: 409 });
      try {
        if (request.method === "DELETE") return Response.json(await browserBridge.removeKey(webProviderKey[1] as WebProvider));
        const body = await request.json().catch(() => ({})) as { key?: unknown };
        return Response.json(await browserBridge.setKey(webProviderKey[1] as WebProvider, typeof body.key === "string" ? body.key : ""));
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const webDecision = /^\/api\/tasks\/([0-9a-f-]{36})\/web-approvals\/([0-9a-f-]{36})\/decision$/.exec(url.pathname);
    if (webDecision && request.method === "POST") {
      if (!await loadLedger(webDecision[1])) return Response.json({ error: "Task not found" }, { status: 404 });
      const body = await request.json().catch(() => ({})) as { approved?: unknown };
      if (typeof body.approved !== "boolean") return Response.json({ error: "Approval decision is required" }, { status: 400 });
      try {
        const approval = await webPermissions.decide(webDecision[1], webDecision[2], body.approved);
        appendActivity(webDecision[1], "status", `网页${approval.kind === "read" ? "读取" : "动作"}${body.approved ? "已批准" : "已拒绝"}：${approval.scope}`);
        return Response.json({ approval });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
    }
    const webTabOpen = /^\/api\/tasks\/([0-9a-f-]{36})\/web-tabs$/.exec(url.pathname);
    if (webTabOpen && request.method === "POST") {
      if (!await loadLedger(webTabOpen[1])) return Response.json({ error: "Task not found" }, { status: 404 });
      const body = await request.json().catch(() => ({})) as { url?: unknown };
      try {
        const tab = await webKernel.openTab(webTabOpen[1], String(body.url ?? ""), undefined, true);
        await webPermissions.grantRead(webTabOpen[1], `domain:${new URL(tab.url).hostname}`);
        return Response.json({ tab });
      }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const webTabAction = /^\/api\/tasks\/([0-9a-f-]{36})\/web-tabs\/([0-9a-f-]{36})\/(focus|close)$/.exec(url.pathname);
    if (webTabAction && request.method === "POST") {
      try {
        if (webTabAction[3] === "focus") await webKernel.focusTab(webTabAction[1], webTabAction[2]);
        else await webKernel.closeTab(webTabAction[1], webTabAction[2]);
        return Response.json({ ok: true });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
    }
    if (url.pathname === "/api/agent-presets" && request.method === "POST") {
      try {
        const body = await request.json() as { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown };
        return Response.json({ preset: await agentPresetStore.create(body) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const presetCopy = /^\/api\/agent-presets\/([a-z][a-z0-9-]{0,63})\/copy$/.exec(url.pathname);
    if (presetCopy && request.method === "POST") {
      try { return Response.json({ preset: await agentPresetStore.copy(presetCopy[1]) }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    if (presetDetail && request.method === "PATCH") {
      try {
        const body = await request.json() as { enabled?: unknown };
        return Response.json({ preset: await agentPresetStore.setEnabled(presetDetail[1], body.enabled as boolean) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    if (presetDetail && request.method === "PUT") {
      try {
        const body = await request.json() as { name?: unknown; description?: unknown; instructions?: unknown; skillIds?: unknown };
        return Response.json({ preset: await agentPresetStore.update(presetDetail[1], body) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    if (presetDetail && request.method === "DELETE") {
      try { await agentPresetStore.delete(presetDetail[1]); return Response.json({ deleted: true }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const skillDecision = /^\/api\/tasks\/([0-9a-f-]{36})\/skills\/([0-9a-f-]{36})\/decision$/.exec(url.pathname);
    if (skillDecision && request.method === "POST") {
      try {
        const body = await request.json() as { decision?: unknown };
        if (body.decision !== "install" && body.decision !== "reject") throw new SkillPluginError("Skill 提案决定无效");
        let ledger = active?.ledger?.state.id === skillDecision[1] ? active.ledger : await loadLedger(skillDecision[1]);
        if (!ledger) return Response.json({ error: "任务不存在" }, { status: 404 });
        if (!await taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const proposal = ledger.state.cognition?.skillProposals?.find(item => item.id === skillDecision[2] && item.status === "pending");
        if (!proposal) throw new SkillPluginError("Skill 提案不存在或已处理");
        const installedSkillId = body.decision === "install" ? (await skillPluginStore.installSelectedSkill(proposal)).skillId : undefined;
        try { await ledger.decideSkillProposal(proposal.id, body.decision === "install" ? "installed" : "rejected", installedSkillId); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.includes("Task ledger changed in another operation") || active?.ledger?.state.id === skillDecision[1]) throw error;
          const latest = await loadLedger(skillDecision[1]);
          const pending = latest?.state.cognition?.skillProposals?.find(item => item.id === proposal.id && item.status === "pending");
          if (!latest || !pending || pending.source !== proposal.source || pending.revision !== proposal.revision || pending.path !== proposal.path) throw new SkillPluginError("任务或提案已变化；请刷新后重新决定");
          await latest.decideSkillProposal(proposal.id, body.decision === "install" ? "installed" : "rejected", installedSkillId);
          ledger = latest;
        }
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        return Response.json({ task: taskView(ledger) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    if (url.pathname === "/api/storage/cleanup-previews" && request.method === "POST") {
      const lease = operationManager.claim("cleanup");
      if (!lease) return Response.json({ error: "请等当前操作结束后再清理预览" }, { status: 409 });
      cleaning = true;
      try { return Response.json(await cleanupStalePreviews(dataRoot, await protectedPreviewIds())); }
      finally { cleaning = false; operationManager.release(lease); }
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      try {
        const patch = await request.json().catch(() => null) as { model?: { default?: unknown; translation?: unknown }; workerModels?: { investigate?: unknown; implement?: unknown; review?: unknown } } | null;
        const nextDefault = patch?.model?.default;
        if (typeof nextDefault === "string" && isModelSelector(nextDefault) && !(await isModelAvailable(nextDefault))) {
          return Response.json({ error: "这个模型没有可用的认证，不能设为默认" }, { status: 400 });
        }
        const nextTranslation = patch?.model?.translation;
        if (typeof nextTranslation === "string" && isModelSelector(nextTranslation) && !(await isModelAvailable(nextTranslation))) {
          return Response.json({ error: "这个模型没有可用的认证，不能用于翻译" }, { status: 400 });
        }
        for (const mode of ["investigate", "implement", "review"] as const) {
          const selected = patch?.workerModels?.[mode];
          if (typeof selected === "string" && isModelSelector(selected) && !(await isModelAvailable(selected))) {
            return Response.json({ error: "这个模型没有可用的认证，不能用于子代理" }, { status: 400 });
          }
        }
        const settings = await settingsStore.update(patch);
        broadcast({ type: "settings", settings });
        return Response.json({ settings });
      } catch (error) {
        if (error instanceof SettingsError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    if (url.pathname === "/api/plugins/install" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({})) as { source?: unknown };
        if (typeof body.source !== "string") throw new SkillPluginError("请输入插件仓库地址");
        return Response.json({ plugin: await skillPluginStore.install(body.source) });
      } catch (error) {
        if (error instanceof SkillPluginError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    const skillPlugin = /^\/api\/plugins\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
    if (skillPlugin && request.method === "PATCH") {
      try {
        const body = await request.json().catch(() => ({})) as { enabled?: unknown; hooksEnabled?: unknown; mcpEnabled?: unknown };
        if ("hooksEnabled" in body) {
          if (typeof body.hooksEnabled !== "boolean") throw new SkillPluginError("Hook 启用状态必须是布尔值");
          return Response.json({ plugin: await skillPluginStore.setHooksEnabled(skillPlugin[1], body.hooksEnabled) });
        }
        if ("mcpEnabled" in body) {
          if (typeof body.mcpEnabled !== "boolean") throw new SkillPluginError("MCP 启用状态必须是布尔值");
          return Response.json({ plugin: await skillPluginStore.setMCPEnabled(skillPlugin[1], body.mcpEnabled) });
        }
        if (typeof body.enabled !== "boolean") throw new SkillPluginError("启用状态必须是布尔值");
        return Response.json({ plugin: await skillPluginStore.setEnabled(skillPlugin[1], body.enabled) });
      } catch (error) {
        if (error instanceof SkillPluginError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    const mcpCheck = /^\/api\/plugins\/([a-z][a-z0-9-]{0,63})\/mcp\/check$/.exec(url.pathname);
    if (mcpCheck && request.method === "POST") {
      const plugin = (await skillPluginStore.list()).find(item => item.id === mcpCheck[1]);
      if (!plugin || !plugin.enabled || !plugin.mcpEnabled) return Response.json({ error: "请先启用插件和 MCP" }, { status: 400 });
      const result = await skillPluginStore.loadMCP(productsRoot, plugin.id);
      try { return Response.json({ tools: result.tools.map(tool => tool.name), errors: result.errors }); }
      finally { await result.manager.disconnectAll(); }
    }
    const mcpPolicy = /^\/api\/plugins\/([a-z][a-z0-9-]{0,63})\/mcp\/permissions$/.exec(url.pathname);
    if (mcpPolicy && request.method === "GET") return Response.json({ permissions: await mcpPermissions.list() });
    if (mcpPolicy && request.method === "PUT") {
      const plugin = (await skillPluginStore.list()).find(item => item.id === mcpPolicy[1]);
      if (!plugin?.enabled || !plugin.mcpEnabled) return Response.json({ error: "请先启用插件和 MCP" }, { status: 400 });
      const body = await request.json().catch(() => ({})) as { tool?: unknown; permission?: unknown };
      if (typeof body.tool !== "string" || !body.tool.startsWith(`mcp__alpha_${plugin.id}_`) || !["deny", "read", "write"].includes(body.permission as string)) return Response.json({ error: "MCP 工具或权限无效" }, { status: 400 });
      await mcpPermissions.set(body.tool, body.permission as MCPPermission);
      return Response.json({ permissions: await mcpPermissions.list() });
    }
    if (url.pathname === "/api/models/test" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { model?: unknown };
      if (!isModelSelector(body.model)) return Response.json({ error: "请选择要测试的模型" }, { status: 400 });
      return Response.json(await testModel(body.model, dataRoot));
    }
    if (url.pathname === "/api/prompts/refine" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { prompt?: unknown; model?: unknown };
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 12_000) return Response.json({ error: "请输入 1–12000 字的提示词" }, { status: 400 });
      if (body.model !== undefined && !isModelSelector(body.model)) return Response.json({ error: "优化模型格式不正确" }, { status: 400 });
      const settings = await settingsStore.get();
      const optimizationModel = typeof body.model === "string" ? body.model : settings.model.default ?? DEFAULT_MODEL;
      const translationModel = settings.model.translation ?? optimizationModel;
      try { return Response.json({ result: await refinePrompt(body.prompt, optimizationModel, translationModel, dataRoot, undefined, request.signal) }); }
      catch (error) {
        if (error instanceof PromptRefinementError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
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
    if (url.pathname === "/api/projects" && request.method === "GET") return Response.json({ projects: await projectStore.list() });
    if (url.pathname === "/api/projects" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { name?: unknown };
      try { return Response.json({ project: await projectStore.create(body.name as string) }, { status: 201 }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const projectSettings = /^\/api\/projects\/([0-9a-f-]{36})\/settings$/.exec(url.pathname);
    if (projectSettings && request.method === "PATCH") {
      const body = await request.json().catch(() => ({})) as { permissionMode?: unknown };
      try { return Response.json({ project: await projectStore.setPermission(projectSettings[1], body.permissionMode as "ask" | "auto" | "full") }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const projectMounts = /^\/api\/projects\/([0-9a-f-]{36})\/mounts$/.exec(url.pathname);
    if (projectMounts && request.method === "POST") {
      if (active || operationManager.snapshot()) return Response.json({ error: "Wait for the current operation before changing mounts" }, { status: 409 });
      const body = await request.json().catch(() => ({})) as { path?: unknown };
      try { const project = await projectStore.mount(projectMounts[1], body.path as string); await pauseTasksForProjectChange(project.id, project.version); return Response.json({ project }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const projectUnmount = /^\/api\/projects\/([0-9a-f-]{36})\/mounts\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (projectUnmount && request.method === "DELETE") {
      if (active || operationManager.snapshot()) return Response.json({ error: "Wait for the current operation before changing mounts" }, { status: 409 });
      try { const project = await projectStore.unmount(projectUnmount[1], projectUnmount[2]); await pauseTasksForProjectChange(project.id, project.version); return Response.json({ project }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const projectTask = /^\/api\/projects\/([0-9a-f-]{36})\/tasks$/.exec(url.pathname);
    const sandboxCheck = /^\/api\/projects\/([0-9a-f-]{36})\/sandbox\/check$/.exec(url.pathname);
    if (sandboxCheck && request.method === "POST") {
      const lease = operationManager.claim("sandbox-check");
      if (!lease) return Response.json({ error: "Another operation is running" }, { status: 409 });
      try {
        const body = await request.json().catch(() => ({})) as { mountId?: unknown };
        const project = await projectStore.get(sandboxCheck[1]);
        const mount = project?.mounts.find(item => item.id === body.mountId);
        if (!project || !mount) return Response.json({ error: "Choose a mounted project folder" }, { status: 400 });
        const roots = await projectStore.roots(project.id, project.version);
        operationManager.update(lease, { phase: "验证 Windows 文件与网络边界" });
        await verifySandbox({ cwd: mount.path, roots, dataRoot, network: project.permissionMode === "full", signal: lease.controller.signal });
        return Response.json({ ok: true });
      } catch (error) { return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 }); }
      finally { operationManager.release(lease); }
    }
    const projectRecheck = /^\/api\/tasks\/([0-9a-f-]{36})\/project\/recheck$/.exec(url.pathname);
    if (projectRecheck && request.method === "POST") {
      const lease = operationManager.claim("sandbox-check", projectRecheck[1]);
      if (!lease) return Response.json({ error: "Another operation is running" }, { status: 409 });
      try {
        const ledger = await loadLedger(projectRecheck[1]);
        const project = ledger?.state.projectId ? await projectStore.get(ledger.state.projectId) : null;
        if (!ledger || !project) return Response.json({ error: "Project task not found" }, { status: 404 });
        const roots = await projectStore.roots(project.id, project.version);
        if (ledger.state.workspaceOrigin?.kind === "direct") {
          if (!roots.some(root => root.toLowerCase() === ledger.state.projectRoot.toLowerCase())) return Response.json({ error: "The original working directory is no longer mounted; create a new task in the replacement directory" }, { status: 409 });
          await verifySandbox({ cwd: ledger.state.projectRoot, roots, dataRoot, network: ledger.state.permissionMode === "full", signal: lease.controller.signal });
        }
        await ledger.confirmProjectVersion(project.version);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        return Response.json({ task: taskView(ledger) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 }); }
      finally { operationManager.release(lease); }
    }
    if (projectTask && request.method === "POST") {
      const lease = operationManager.claim("run");
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
        const body = await request.json().catch(() => ({})) as { mountId?: unknown; objective?: unknown; model?: unknown; permissionMode?: unknown; expertId?: unknown; startMode?: unknown; continueUntilAccepted?: unknown };
        const launch = startOptions(body.startMode, body.continueUntilAccepted);
        if (!launch) return Response.json({ error: "Invalid task start options" }, { status: 400 });
        const project = await projectStore.get(projectTask[1]);
        if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
        const mount = project.mounts.find(item => item.id === body.mountId);
        const objective = typeof body.objective === "string" ? body.objective.trim() : "";
        if (!mount || !objective || !["ask", "auto", "full"].includes(body.permissionMode as string)) return Response.json({ error: "Mount, objective and permission mode are required" }, { status: 400 });
        await projectStore.roots(project.id, project.version);
        if (body.model !== undefined && body.model !== null && !isModelSelector(body.model)) return Response.json({ error: "模型格式不正确" }, { status: 400 });
        const model = typeof body.model === "string" ? body.model : undefined;
        if (model && !(await isModelAvailable(model))) return Response.json({ error: "这个模型没有可用的认证" }, { status: 400 });
        const expertId = typeof body.expertId === "string" && body.expertId ? body.expertId : undefined;
        if (body.expertId != null && body.expertId !== "" && (!expertId || !(await agentPresetStore.enabled()).some(item => item.id === expertId))) return Response.json({ error: "指定专家不存在或未启用" }, { status: 400 });
        const ledger = await TaskLedger.create(dataRoot, { objective, projectRoot: mount.path, taskType: "code-change", projectId: project.id, projectVersion: project.version,
          permissionMode: body.permissionMode as "ask" | "auto" | "full", workspaceOrigin: { kind: "direct", checks: await configuredChecks(mount.path) }, modelSelector: model, designatedExpertId: expertId,
          ...launch,
          criteria: [{ id: "change", description: "Source changes are reviewable", kind: "asset" }, { id: "check", description: "Configured project checks pass", kind: "test" }],
        });
        const baseline = await snapshotSourceHashes(mount.path);
        await mkdir(directBaselineRoot, { recursive: true });
        await writeFile(join(directBaselineRoot, `${ledger.state.id}.json`), JSON.stringify({ format: 2, files: baseline }), { flag: "wx" });
        operationManager.update(lease, { taskId: ledger.state.id });
        if (lease.controller.signal.aborted) { await ledger.stop(); return Response.json({ error: "Task was cancelled", taskId: ledger.state.id }, { status: 409 }); }
        const runId = randomUUID();
        active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
        setContext(ledger);
        operations.set(ledger.state.id, runId);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        launched = true;
        void execute(runId, objective, mount.path, lease.controller, lease, ledger);
        return Response.json({ taskId: ledger.state.id, runId });
      } finally { if (!launched) operationManager.release(lease); }
    }
    if (url.pathname === "/api/workspaces/import" && request.method === "POST") {
      const lease = operationManager.claim("run");
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
        const body = await request.json().catch(() => ({})) as { sourcePath?: unknown; objective?: unknown; model?: unknown; expertId?: unknown; startMode?: unknown; continueUntilAccepted?: unknown };
        const launch = startOptions(body.startMode, body.continueUntilAccepted);
        if (!launch) return Response.json({ error: "Invalid task start options" }, { status: 400 });
        const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
        const objective = typeof body.objective === "string" ? body.objective.trim() : "";
        if (!sourcePath || !objective) return Response.json({ error: "Source path and objective are required" }, { status: 400 });
        if (body.model !== undefined && body.model !== null && !isModelSelector(body.model)) return Response.json({ error: "模型格式不正确" }, { status: 400 });
        const model = typeof body.model === "string" ? body.model : undefined;
        if (model && !(await isModelAvailable(model))) return Response.json({ error: "这个模型没有可用的认证" }, { status: 400 });
        const expertId = typeof body.expertId === "string" && body.expertId ? body.expertId : undefined;
        if (body.expertId != null && body.expertId !== "" && (!expertId || !(await agentPresetStore.enabled()).some(item => item.id === expertId))) return Response.json({ error: "指定专家不存在或未启用" }, { status: 400 });
        const ledger = await importCodeWorkspace({ sourcePath, productsRoot, dataRoot, objective, modelSelector: model, designatedExpertId: expertId, ...launch });
        operationManager.update(lease, { taskId: ledger.state.id });
        if (lease.controller.signal.aborted) { await ledger.stop(); return Response.json({ error: "Import was cancelled", taskId: ledger.state.id }, { status: 409 }); }
        const runId = randomUUID();
        active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
        setContext(ledger);
        operations.set(ledger.state.id, runId);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        launched = true;
        void execute(runId, objective, ledger.state.projectRoot, lease.controller, lease, ledger);
        return Response.json({ taskId: ledger.state.id, runId });
      } finally { if (!launched) operationManager.release(lease); }
    }
    if (url.pathname === "/api/workflows" && request.method === "POST") {
      const lease = operationManager.claim("run");
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
        const form = await request.formData();
        const taskType = form.get("taskType");
        const objective = form.get("objective");
        const modelValue = form.get("model");
        const launch = startOptions(form.get("startMode") ?? undefined, form.has("continueUntilAccepted") ? form.get("continueUntilAccepted") === "true" : undefined);
        if (!launch || form.has("continueUntilAccepted") && !["true", "false"].includes(String(form.get("continueUntilAccepted")))) return Response.json({ error: "Invalid task start options" }, { status: 400 });
        if (taskType !== "research" && taskType !== "file-work" || typeof objective !== "string" || !objective.trim()) return Response.json({ error: "Task type and objective are required" }, { status: 400 });
        const model = typeof modelValue === "string" && modelValue ? modelValue : undefined;
        if (model && (!isModelSelector(model) || !(await isModelAvailable(model)))) return Response.json({ error: "Model is unavailable" }, { status: 400 });
        const files = await Promise.all(form.getAll("files").map(async item => {
          if (!(item instanceof File)) throw new Error("Input must be a file");
          return { name: item.name, mimeType: item.type, bytes: new Uint8Array(await item.arrayBuffer()) };
        }));
        const ledger = await createGeneralWorkspace({ taskType, objective, productsRoot, dataRoot, modelSelector: model, files, ...launch });
        operationManager.update(lease, { taskId: ledger.state.id });
        if (lease.controller.signal.aborted) { await ledger.stop(); return Response.json({ error: "Task was cancelled", taskId: ledger.state.id }, { status: 409 }); }
        const runId = randomUUID();
        active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
        setContext(ledger);
        operations.set(ledger.state.id, runId);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        launched = true;
        void execute(runId, objective, ledger.state.projectRoot, lease.controller, lease, ledger);
        return Response.json({ taskId: ledger.state.id, runId });
      } finally { if (!launched) operationManager.release(lease); }
    }
    if (url.pathname === "/api/tasks/general" && request.method === "POST") {
      try {
        const form = await request.formData();
        const objective = String(form.get("objective") ?? "").trim();
        const modelValue = form.get("model");
        const model = typeof modelValue === "string" && modelValue ? modelValue : undefined;
        const launch = startOptions(form.get("startMode") ?? undefined, form.has("continueUntilAccepted") ? form.get("continueUntilAccepted") === "true" : undefined);
        if (!objective || !launch) return Response.json({ error: "Objective and valid start options are required" }, { status: 400 });
        if (model && (!isModelSelector(model) || !(await isModelAvailable(model)))) return Response.json({ error: "Model is unavailable" }, { status: 400 });
        const projectId = String(form.get("projectId") ?? "");
        const mountId = String(form.get("mountId") ?? "");
        const project = projectId ? await projectStore.get(projectId) : null;
        if (projectId && !project) return Response.json({ error: "Project not found" }, { status: 404 });
        const mount = project?.mounts.find(item => item.id === mountId);
        if (mountId && !mount) return Response.json({ error: "Primary working directory is not mounted" }, { status: 400 });
        if (project?.mounts.length && !mount) return Response.json({ error: "Choose the primary working directory" }, { status: 400 });
        const permissionMode = form.get("permissionMode") ?? project?.permissionMode ?? "ask";
        if (!["ask", "auto", "full"].includes(String(permissionMode))) return Response.json({ error: "Invalid permission mode" }, { status: 400 });
        const roots = project ? await projectStore.roots(project.id, project.version) : [];
        if (mount) {
          await verifySandbox({ cwd: mount.path, roots, dataRoot, network: permissionMode === "full", signal: new AbortController().signal });
        }
        const skillIds = JSON.parse(String(form.get("skillIds") ?? "[]")) as unknown;
        const pluginIds = JSON.parse(String(form.get("pluginIds") ?? "[]")) as unknown;
        const capabilities = await selectedCapabilities(skillIds, pluginIds, !!mount);
        const files = await uploadedFiles(form.getAll("files"));
        const projectRoot = mount?.path ?? (project ? join(productsRoot, `project-${project.id}`) : join(productsRoot, `work-${randomUUID()}`));
        if (!mount) await mkdir(projectRoot, { recursive: true });
        const ledger = await TaskLedger.create(dataRoot, { objective, projectRoot, taskType: "general", criteria: [],
          workspaceOrigin: { kind: mount ? "direct" : "generated", ...(mount ? { checks: await configuredChecks(mount.path) } : {}) },
          ...(project ? { projectId: project.id, projectVersion: project.version, permissionMode: permissionMode as "ask" | "auto" | "full" } : {}),
          capabilities, modelSelector: model, ...launch,
        });
        await addTaskInputs(ledger, dataRoot, files);
        const baseline = await snapshotSourceHashes(projectRoot);
        await mkdir(directBaselineRoot, { recursive: true });
        await writeFile(join(directBaselineRoot, `${ledger.state.id}.json`), JSON.stringify({ format: 2, files: baseline }), { flag: "wx" });
        await taskQueue.enqueue(ledger.state.id, objective);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger, true) });
        await drainQueue();
        const runId = active?.ledger?.state.id === ledger.state.id ? active.runId : null;
        return Response.json({ taskId: ledger.state.id, runId, queued: !runId });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    const approvals = /^\/api\/tasks\/([0-9a-f-]{36})\/approvals$/.exec(url.pathname);
    if (approvals && request.method === "GET") {
      const ledger = await loadLedger(approvals[1]);
      if (!ledger || !["code-change", "general"].includes(ledger.state.taskType ?? "")) return Response.json({ error: "Code task not found" }, { status: 404 });
      return Response.json({ approvals: await commandApprovals.list(ledger.state.id) });
    }
    const approvalDecision = /^\/api\/tasks\/([0-9a-f-]{36})\/approvals\/([0-9a-f-]{36})\/decision$/.exec(url.pathname);
    if (approvalDecision && request.method === "POST") {
      const ledger = await loadLedger(approvalDecision[1]);
      if (!ledger || !["code-change", "general"].includes(ledger.state.taskType ?? "")) return Response.json({ error: "Code task not found" }, { status: 404 });
      const body = await request.json().catch(() => ({})) as { approved?: unknown };
      if (typeof body.approved !== "boolean") return Response.json({ error: "Approval decision is required" }, { status: 400 });
      try {
        const approval = await commandApprovals.decide(ledger.state.id, approvalDecision[2], body.approved);
        appendActivity(ledger.state.id, "status", `命令${body.approved ? "已批准" : "已拒绝"}：${approval.argv.join(" ")}`);
        return Response.json({ approval });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
    }
    const applyReview = /^\/api\/tasks\/([0-9a-f-]{36})\/apply-review$/.exec(url.pathname);
    if (applyReview && request.method === "GET") {
      const ledger = await loadLedger(applyReview[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      try { return Response.json(await reviewCodeApply(ledger, dataRoot)); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
    }
    const applyTask = /^\/api\/tasks\/([0-9a-f-]{36})\/apply$/.exec(url.pathname);
    if (applyTask && request.method === "POST") {
      const lease = operationManager.claim("apply", applyTask[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      try {
        const ledger = await loadLedger(applyTask[1]);
        if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
        const body = await request.json().catch(() => ({})) as { revision?: unknown };
        if (typeof body.revision !== "string") return Response.json({ error: "Reviewed revision is required" }, { status: 400 });
        const review = await reviewCodeApply(ledger, dataRoot);
        const sourceRoot = ledger.state.workspaceOrigin?.sourcePath;
        if (!sourceRoot) return Response.json({ error: "Import source is missing" }, { status: 409 });
        const turn = await prepareProjectTurn({ dataRoot, projectRoot: sourceRoot, runId: randomUUID(), ledger });
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
        try { changes = await applyCodeChanges(ledger, dataRoot, body.revision); }
        catch (error) { applyError = error instanceof Error ? error.message : String(error); await ledger.recordCheckpointFailure(`应用失败：${applyError}`); }
        try { await finalizeProjectTurn(turn, ledger); }
        catch (error) {
          const reason = `应用后自动提交失败：${error instanceof Error ? error.message : String(error)}`;
          await ledger.recordCheckpointFailure(reason);
          return Response.json({ error: reason }, { status: 409 });
        }
        if (applyError) await ledger.recordCheckpointFailure(`应用失败：${applyError}`);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        if (applyError) return Response.json({ error: applyError }, { status: 409 });
        appendActivity(ledger.state.id, "status", `隔离成果已应用回原项目：${changes.length} 个文件`);
        return Response.json({ applied: changes });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
      finally { operationManager.release(lease); }
    }
    if (url.pathname === "/api/tasks" && request.method === "POST") {
      const lease = operationManager.claim("run");
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
      const body = await request.json().catch(() => ({})) as { brief?: unknown; model?: unknown; expertId?: unknown; startMode?: unknown; continueUntilAccepted?: unknown };
      const launch = startOptions(body.startMode, body.continueUntilAccepted);
      if (!launch) return Response.json({ error: "Invalid task start options" }, { status: 400 });
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      if (!brief) return Response.json({ error: "Brief is required" }, { status: 400 });
      if (body.model !== undefined && body.model !== null && !isModelSelector(body.model)) return Response.json({ error: "模型格式不正确" }, { status: 400 });
      const chosenModel = typeof body.model === "string" ? body.model : undefined;
      if (chosenModel && !(await isModelAvailable(chosenModel))) return Response.json({ error: "这个模型没有可用的认证" }, { status: 400 });
      const expertId = typeof body.expertId === "string" && body.expertId ? body.expertId : undefined;
      if (body.expertId != null && body.expertId !== "" && (!expertId || !(await agentPresetStore.enabled()).some(item => item.id === expertId))) return Response.json({ error: "指定专家不存在或未启用" }, { status: 400 });
      const runId = randomUUID();
      const projectRoot = join(productsRoot, runId);
      await mkdir(productsRoot, { recursive: true });
      await cp(join(appRoot, "templates", "web-minimal"), projectRoot, { recursive: true });
      const controller = lease.controller;
      controller.signal.throwIfAborted();
      active = { runId, controller, steeringIds: new Set() };
      launched = true;
       void execute(runId, brief, projectRoot, controller, lease, undefined, chosenModel, expertId, launch);
      return Response.json({ runId, projectRoot });
      } finally {
        if (!launched) operationManager.release(lease);
      }
    }
    const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancel && request.method === "POST") {
      if (active?.runId !== cancel[1]) return Response.json({ error: "Task is not running" }, { status: 404 });
      active.controller.abort();
      return Response.json({ stopping: true });
    }
    const cancelOperation = /^\/api\/operations\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname);
    if (cancelOperation && request.method === "POST") {
      return operationManager.cancel(cancelOperation[1])
        ? Response.json({ stopping: true })
        : Response.json({ error: "Operation is not cancellable" }, { status: 404 });
    }
    if (url.pathname === "/api/browser/control" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { holder?: unknown };
      if (body.holder !== "alpha" && body.holder !== "user") return Response.json({ error: "Invalid browser holder" }, { status: 400 });
      webKernel.setControl(body.holder);
      if (webKernel.controlHolder === "user") {
        verification?.controller.abort(new Error("User took over the browser"));
      }
      emit({ type: "control", holder: webKernel.controlHolder });
      return Response.json({ holder: webKernel.controlHolder });
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
    const taskMessage = /^\/api\/tasks\/([0-9a-f-]{36})\/messages$/.exec(url.pathname);
    if (taskMessage && request.method === "POST") {
      const form = await request.formData();
      const text = String(form.get("text") ?? "").trim();
      const files = await uploadedFiles(form.getAll("files"));
      if (!text && !files.length && active?.ledger?.state.id === taskMessage[1]) return Response.json({ error: "Message or attachments are required" }, { status: 400 });
      const selected = form.has("skillIds") || form.has("pluginIds");
      const live = active?.ledger?.state.id === taskMessage[1] && !!active.steer;
      if (active && !live) return Response.json({ error: "Wait until this task can accept a message" }, { status: 409 });
      if (live) {
        if (selected) return Response.json({ error: "Skill and plugin changes take effect on the next run" }, { status: 409 });
        const ledger = active!.ledger!;
        await addTaskInputs(ledger, dataRoot, files);
        const instruction = [text, ...files.map(file => `Attached: ${file.name}`)].filter(Boolean).join("\n");
        const id = await ledger.recordGuidance(instruction);
        appendActivity(ledger.state.id, "guidance", `补充要求已记录：${instruction}`);
        await deliverGuidance(ledger, id, instruction, active!.steer!);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        return Response.json({ taskId: ledger.state.id, delivered: true });
      }
      const lease = operationManager.claim("run", taskMessage[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
        const ledger = await loadLedger(taskMessage[1]);
        if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
        if (!await taskRootAllowed(ledger)) return Response.json({ error: "Project folders changed; review the project before continuing" }, { status: 409 });
        const capabilities = selected ? await selectedCapabilities(JSON.parse(String(form.get("skillIds") ?? "[]")), JSON.parse(String(form.get("pluginIds") ?? "[]")), ledger.state.workspaceOrigin?.kind === "direct") : null;
        if (ledger.state.status === "complete" || form.get("forceRevision") === "true") {
          if (!text) return Response.json({ error: "A modification request is required for a completed task" }, { status: 400 });
          await ledger.reviseObjective(text);
        }
        if (capabilities) await ledger.setCapabilities(capabilities);
        await addTaskInputs(ledger, dataRoot, files);
        const instruction = [text || "Review the newly attached materials and continue the task.", ...files.map(file => `Attached: ${file.name}`)].join("\n");
        if (ledger.state.phase === "plan-review") await ledger.enterPlan();
        else if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(instruction);
        else if (ledger.state.status !== "complete") await ledger.recordGuidance(instruction);
        appendActivity(ledger.state.id, "guidance", `新消息：${instruction}`);
        const runId = randomUUID();
        active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
        setContext(ledger);
        operations.set(ledger.state.id, runId);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        launched = true;
        void execute(runId, instruction, ledger.state.projectRoot, lease.controller, lease, ledger);
        return Response.json({ taskId: ledger.state.id, runId, contractVersion: ledger.state.contractVersion });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
      finally { if (!launched) operationManager.release(lease); }
    }
    const enterPlan = /^\/api\/tasks\/([0-9a-f-]{36})\/plan\/enter$/.exec(url.pathname);
    if (enterPlan && request.method === "POST") {
      const lease = operationManager.claim("run", enterPlan[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
        const ledger = await loadLedger(enterPlan[1]);
        if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
        if (!await taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        await ledger.enterPlan();
        const runId = randomUUID();
        active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
        setContext(ledger);
        operations.set(ledger.state.id, runId);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        launched = true;
        void execute(runId, "Investigate the current task and record a revised plan for user review.", ledger.state.projectRoot, lease.controller, lease, ledger);
        return Response.json({ taskId: ledger.state.id, runId });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
      finally { if (!launched) operationManager.release(lease); }
    }
    const approvePlan = /^\/api\/tasks\/([0-9a-f-]{36})\/plan\/approve$/.exec(url.pathname);
    if (approvePlan && request.method === "POST") {
      const lease = operationManager.claim("run", approvePlan[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
        const ledger = await loadLedger(approvePlan[1]);
        if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
        if (!await taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
        const body = await request.json().catch(() => ({})) as { contractVersion?: unknown; cognitionRevision?: unknown; sourceRevision?: unknown };
        if (!Number.isSafeInteger(body.contractVersion) || !Number.isSafeInteger(body.cognitionRevision) || typeof body.sourceRevision !== "string") return Response.json({ error: "Expected plan and source versions are required" }, { status: 400 });
        await ledger.approvePlan({ contractVersion: body.contractVersion as number, cognitionRevision: body.cognitionRevision as number, sourceRevision: body.sourceRevision });
        const runId = randomUUID();
        active = { runId, controller: lease.controller, ledger, steeringIds: new Set() };
        setContext(ledger);
        operations.set(ledger.state.id, runId);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
        launched = true;
        void execute(runId, "Execute the approved plan and verify the current task against its acceptance criteria.", ledger.state.projectRoot, lease.controller, lease, ledger);
        return Response.json({ taskId: ledger.state.id, runId });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
      finally { if (!launched) operationManager.release(lease); }
    }
    const goalToggle = /^\/api\/tasks\/([0-9a-f-]{36})\/goal$/.exec(url.pathname);
    if (goalToggle && request.method === "PATCH") {
      if (operationManager.snapshot()) return Response.json({ error: "Wait for the current operation to finish" }, { status: 409 });
      const ledger = await loadLedger(goalToggle[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      const body = await request.json().catch(() => ({})) as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") return Response.json({ error: "Goal continuation setting is required" }, { status: 400 });
      const configured = await configuredRun(ledger.state.modelSelector, ledger);
      await ledger.setGoal(body.enabled, { maxToolCalls: configured.maxToolCalls, wallTimeMs: configured.wallTimeMs, maxTotalToolCalls: configured.maxTotalToolCalls, totalWallTimeMs: configured.totalWallTimeMs });
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      return Response.json({ task: taskView(ledger) });
    }
    const revise = /^\/api\/tasks\/([0-9a-f-]{36})\/revise$/.exec(url.pathname);
    if (revise && request.method === "POST") {
      const lease = operationManager.claim("run", revise[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
      const ledger = await loadLedger(revise[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      const projectRoot = resolve(ledger.state.projectRoot);
      if (!await taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
      const body = await request.json().catch(() => ({})) as { brief?: unknown };
      const brief = typeof body.brief === "string" ? body.brief.trim() : "";
      if (!brief || brief === ledger.state.objective) return Response.json({ error: "A changed task objective is required" }, { status: 400 });
      const previousPreviewId = ledger.state.preview?.id;
      await ledger.reviseObjective(brief);
      lease.controller.signal.throwIfAborted();
      if (previousPreviewId) {
        previews.get(previousPreviewId)?.stop();
        previews.delete(previousPreviewId);
      }
      const controller = lease.controller;
      const runId = randomUUID();
      active = { runId, controller, ledger, steeringIds: new Set() };
      setContext(ledger);
      operations.set(ledger.state.id, runId);
      appendActivity(ledger.state.id, "status", `目标修订至 v${ledger.state.contractVersion}`, runId);
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      launched = true;
      void execute(runId, brief, projectRoot, controller, lease, ledger);
      return Response.json({ runId, taskId: ledger.state.id, contractVersion: ledger.state.contractVersion });
      } finally {
        if (!launched) operationManager.release(lease);
      }
    }
    const resume = /^\/api\/tasks\/([0-9a-f-]{36})\/resume$/.exec(url.pathname);
    if (resume && request.method === "POST") {
      const lease = operationManager.claim("run", resume[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      let launched = false;
      try {
      const ledger = await loadLedger(resume[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (ledger.state.status === "complete") return Response.json({ error: "Task is already complete" }, { status: 409 });
      if (ledger.state.phase === "plan-review") return Response.json({ error: "Review the plan before execution or return to planning" }, { status: 409 });
      const projectRoot = resolve(ledger.state.projectRoot);
      if (!await taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
      const body = await request.json().catch(() => ({})) as { brief?: unknown };
      const correction = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : ledger.state.phase === "plan" ? "Continue investigating and revise the plan for review." : "Repair the pending acceptance checks while preserving the original objective.";
      if (ledger.state.status === "stopped" || ledger.state.status === "needs-input") await ledger.resume(correction);
      else await ledger.recordGuidance(correction);
      lease.controller.signal.throwIfAborted();
      const controller = lease.controller;
      const runId = randomUUID();
      active = { runId, controller, ledger, steeringIds: new Set() };
      setContext(ledger);
      operations.set(ledger.state.id, runId);
      launched = true;
      void execute(runId, correction, projectRoot, controller, lease, ledger);
      return Response.json({ runId, taskId: ledger.state.id });
      } finally {
        if (!launched) operationManager.release(lease);
      }
    }
    const publish = /^\/api\/tasks\/([0-9a-f-]{36})\/publish$/.exec(url.pathname);
    if (publish && request.method === "POST") {
      const lease = operationManager.claim("publish", publish[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      publishing = true;
      try {
      const ledger = await loadLedger(publish[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      setContext(ledger);
      const publishRunId = randomUUID();
      operations.set(ledger.state.id, publishRunId);
      if (ledger.state.status === "stopped") return Response.json({ error: "Task is stopped" }, { status: 409 });
      const projectRoot = resolve(ledger.state.projectRoot);
      if (!await taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
      const currentPreview = ledger.state.preview;
      if (currentPreview && previews.has(currentPreview.id) && (await fingerprintSource(projectRoot)) === currentPreview.revision) {
        return Response.json(currentPreview);
      }
      if (ledger.state.status === "complete") await ledger.reopen("Local preview was republished and needs browser verification");
      if (!ledger.state.development?.enabled && (ledger.state.taskType === "web-product" || ledger.state.taskType === "code-change")) await ledger.enableDevelopmentWorkflow();
      await ledger.refreshRevision();
       const controller = lease.controller;
      if (!(await build(projectRoot, ledger, controller.signal))) return Response.json({ error: "Build failed" }, { status: 422 });
      const instance = await publishPreview(ledger, projectRoot);
      emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: publishRunId, pending: ledger.completionGaps() });
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
      {
        emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: publishRunId, pending: ledger.completionGaps() });
        try {
           await controlledVerification(ledger, controller.signal, lease);
          const verified = await TaskLedger.load(ledger.file);
          emit({ type: "task", taskId: ledger.state.id, task: taskView(verified) });
          emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
          emit({ type: "status", taskId: ledger.state.id, phase: verified.completionGaps().length ? "待验收" : "已验收", runId: publishRunId, pending: verified.completionGaps() });
        } catch (error) {
          const current = await TaskLedger.load(ledger.file);
          if (webKernel.controlHolder === "user") {
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
         operationManager.release(lease);
       }
    }
    const verify = /^\/api\/tasks\/([0-9a-f-]{36})\/verify$/.exec(url.pathname);
    if (verify && request.method === "POST") {
      const lease = operationManager.claim("verify", verify[1]);
      if (!lease) return Response.json({ error: "A task is already running" }, { status: 409 });
      try {
      const ledger = await loadLedger(verify[1]);
      if (!ledger) return Response.json({ error: "Task not found" }, { status: 404 });
      if (ledger.state.status !== "active" || !ledger.state.preview || !previews.has(ledger.state.preview.id)) return Response.json({ error: "A live active preview is required" }, { status: 409 });
      if (!await taskRootAllowed(ledger)) return Response.json({ error: "Task workspace is unavailable" }, { status: 403 });
      if (!ledger.state.development?.enabled && (ledger.state.taskType === "web-product" || ledger.state.taskType === "code-change")) await ledger.enableDevelopmentWorkflow();
      setContext(ledger);
      const verifyRunId = randomUUID();
      operations.set(ledger.state.id, verifyRunId);
      try {
        emit({ type: "status", taskId: ledger.state.id, phase: "浏览器验收", runId: verifyRunId, pending: ledger.completionGaps() });
         await controlledVerification(ledger, lease.controller.signal, lease);
        const verified = await TaskLedger.load(ledger.file);
        emit({ type: "task", taskId: ledger.state.id, task: taskView(verified) });
        emit({ type: "tool", taskId: ledger.state.id, name: "browser", state: "通过" });
        emit({ type: "status", taskId: ledger.state.id, phase: verified.completionGaps().length ? "待验收" : "已验收", runId: verifyRunId, pending: verified.completionGaps() });
        return Response.json({ task: taskView(verified) });
      } catch (error) {
        const current = await TaskLedger.load(ledger.file);
        if (webKernel.controlHolder === "user") {
          emit({ type: "status", taskId: ledger.state.id, phase: "用户接管", runId: verifyRunId, pending: current.completionGaps() });
          return Response.json({ paused: true, task: taskView(current) }, { status: 202 });
        }
        if (current.state.status === "active") await current.recordFailure(error instanceof Error ? error.message : String(error));
        emit({ type: "status", taskId: ledger.state.id, phase: "待验收", runId: verifyRunId, pending: current.completionGaps() });
        return Response.json({ error: error instanceof Error ? error.message : String(error), task: taskView(current) }, { status: 422 });
       } finally {
         operations.delete(ledger.state.id);
       }
      } finally {
        operationManager.release(lease);
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
await taskQueue.advanceDue();
await automationStore.advanceDue();
void drainQueue();
void drainAutomations();
const scheduleTimer = setInterval(() => {
  void taskQueue.advanceDue().then(() => drainQueue()).catch(error => console.error("ALPHA_SCHEDULE_FAILED", error));
  void automationStore.advanceDue().then(() => drainAutomations()).catch(error => console.error("ALPHA_AUTOMATION_FAILED", error));
}, 15_000);
process.on("SIGINT", () => { clearInterval(scheduleTimer); active?.controller.abort(); for (const preview of previews.values()) preview.stop(); server.stop(true); });
