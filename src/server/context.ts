import { createHash, randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { access, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { PreviewInstance } from "../runtime/local-preview";
import { DEFAULT_MODEL } from "../runtime/omp-runner";
import { generateTaskTitle } from "../runtime/task-title";
import { setAllowedModelProviders } from "../runtime/model-policy";
import { isModelAvailable } from "../runtime/models";
import { TaskLedger } from "../runtime/task-ledger";
import { TaskActivity, type ActivityKind } from "../runtime/task-activity";
import { SettingsStore, WorkbenchMeta } from "../runtime/settings";
import { ComfyClient } from "../runtime/comfy-client";
import { SkillPluginStore, hashSkillDirectory } from "../plugins/third-party";
import { AgentPresetStore } from "../runtime/agent-presets";
import { BrowserLock, OperationManager, type OperationLease } from "../runtime/operation-manager";
import { BrowserBridge } from "../runtime/browser-bridge";
import { BrowserKernel } from "../runtime/browser-kernel";
import { WebPermissionStore } from "../runtime/web-permissions";
import { WebRetrieval, type WebProvider } from "../runtime/web-retrieval";
import { commandApprovalStore } from "../runtime/command-approval";
import type { UploadedInput } from "../runtime/general-work";
import { MCPPermissionStore } from "../runtime/mcp-permissions";
import { OperationJournal } from "../runtime/operation-journal";
import { TaskQueueStore } from "../runtime/task-queue";
import { AutomationStore } from "../runtime/automations";
import { ProjectStore } from "../runtime/projects";

/** A model operation in progress. Tasks run side by side, so there is one of these per running task. */
export interface RunState {
  runId: string;
  kind: "run" | "answer";
  lease: OperationLease;
  /** Known once the task exists; a new web product only gets its task during the run. */
  taskId: string | null;
  ledger?: TaskLedger;
  steer?: (text: string) => Promise<void>;
  steeringIds: Set<string>;
}

type ActivityDetail = { callId?: string; target?: string; intent?: string; error?: boolean };

export async function createServerContext() {
  const appRoot = resolve(import.meta.dir, "..", "..");
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
  setAllowedModelProviders((await settingsStore.get()).model.providers);
  const browserBridge = process.env.ALPHA_BROWSER_BRIDGE_PORT && process.env.ALPHA_BROWSER_BRIDGE_TOKEN ? new BrowserBridge() : null;
  const workbenchMeta = new WorkbenchMeta(dataRoot);
  const projectStore = new ProjectStore(dataRoot);
  const clients = new Set<ServerWebSocket<unknown>>();
  const runs = new Map<string, RunState>();
  const activities = new Map<string, TaskActivity>();
  /** taskId → id of the operation whose activity entries are being recorded. */
  const operationIds = new Map<string, string>();
  const contexts = new Map<string, { contractVersion: number; revision: string | null; previewId: string | null }>();
  const textBuffers = new Map<string, string>();
  const textTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const state = {
    taskMeta: await workbenchMeta.all(),
    queueDraining: false,
    automationDraining: false,
  };

  function broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const client of clients) client.send(data);
  }

  const operations = new OperationManager(snapshots => broadcast({ type: "operations", operations: snapshots }));

  function runForTask(taskId: string): RunState | undefined {
    for (const run of runs.values()) if (run.taskId === taskId) return run;
    return undefined;
  }

  function activityFor(taskId: string): TaskActivity {
    let activity = activities.get(taskId);
    if (!activity) {
      activity = new TaskActivity(dataRoot, taskId);
      activities.set(taskId, activity);
    }
    return activity;
  }

  function setContext(ledger: TaskLedger): void {
    contexts.set(ledger.state.id, { contractVersion: ledger.state.contractVersion ?? 1, revision: ledger.state.revision, previewId: ledger.state.preview?.id ?? null });
  }

  function appendActivity(taskId: string, kind: ActivityKind, value: string, operationId?: string, detail: ActivityDetail = {}): void {
    const context = contexts.get(taskId);
    const activity = activityFor(taskId);
    const optional = Object.fromEntries(Object.entries(detail).filter(([, item]) => item !== undefined && item !== false)) as ActivityDetail;
    const entry = activity.create({
      operationId: operationId ?? operationIds.get(taskId) ?? null,
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

  function emit(message: unknown): void {
    const event = message as { type?: string; taskId?: string; runId?: string; value?: string; phase?: string; name?: string; state?: string; message?: string; url?: string; error?: boolean; callId?: string; target?: string; intent?: string; task?: { id: string; contractVersion: number; revision: string | null; preview: { id: string } | null } };
    const operation = event.taskId ? operations.forTask(event.taskId) : null;
    if (event.type === "status" && event.phase && operation) operations.update({ id: operation.id }, { phase: event.phase });
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

  const previews = new Map<string, PreviewInstance>();

  function runFields(ledger: TaskLedger) {
    const run = runForTask(ledger.state.id);
    return { running: !!run, runKind: run?.kind ?? null, acceptsGuidance: run?.kind === "run" && !!run.steer };
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
      meta: state.taskMeta[ledger.state.id] ?? {},
      ...runFields(ledger),
      queued,
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
      meta: state.taskMeta[ledger.state.id] ?? {},
      ...runFields(ledger),
      queued,
      pendingCount: ledger.completionGaps().length,
      createdAt: ledger.state.createdAt,
      updatedAt: ledger.state.updatedAt,
    };
  }

  /** Current ledger of a task: the running operation's instance when there is one, so views never lag the run. */
  async function currentLedger(taskId: string): Promise<TaskLedger | null> {
    return runForTask(taskId)?.ledger ?? await loadLedger(taskId);
  }

  async function listTasks(): Promise<TaskLedger[]> {
    const names = (await readdir(join(dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const ledgers = (await Promise.all(names.map(name => TaskLedger.load(join(dataRoot, "tasks", name)).catch(() => null)))).filter((ledger): ledger is TaskLedger => ledger !== null);
    return ledgers.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
  }

  const taskSnapshots = new Map<string, { mtimeMs: number; size: number; ledger: TaskLedger }>();

  /**
   * Read-only view of every task for listings, which the workbench refreshes often. A ledger file is parsed again only
   * when its size or modification time changes. Callers must not mutate the returned ledgers; use listTasks() for that.
   */
  async function taskSnapshotList(): Promise<TaskLedger[]> {
    const directory = join(dataRoot, "tasks");
    const names = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const ledgers = await Promise.all(names.map(async name => {
      const file = join(directory, name);
      const info = await stat(file).catch(() => null);
      if (!info) return null;
      const cached = taskSnapshots.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.ledger;
      const ledger = await TaskLedger.load(file).catch(() => null);
      if (ledger) taskSnapshots.set(file, { mtimeMs: info.mtimeMs, size: info.size, ledger });
      return ledger;
    }));
    const present = new Set(names.map(name => join(directory, name)));
    for (const file of taskSnapshots.keys()) if (!present.has(file)) taskSnapshots.delete(file);
    return ledgers.filter((ledger): ledger is TaskLedger => ledger !== null).sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
  }

  async function pauseTasksForProjectChange(projectId: string, version: number): Promise<void> {
    for (const ledger of await listTasks()) {
      if (ledger.state.projectId !== projectId || (ledger.state.projectVersion ?? 0) >= version || ledger.state.status !== "active") continue;
      await ledger.needInput("项目目录范围已变化，请重新检查后继续", "project");
      emit({ type: "task", taskId: ledger.state.id, task: taskView(ledger) });
    }
  }

  async function protectedPreviewIds(): Promise<Set<string>> {
    return new Set([...previews.keys(), ...(await taskSnapshotList()).flatMap(task => task.state.preview ? [task.state.preview.id] : [])]);
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

  /** Names a new task in the background; the objective-derived title shows until, and unless, this succeeds. */
  function nameTask(ledger: TaskLedger, fixed?: string): void {
    const id = ledger.state.id;
    void (async () => {
      const model = ledger.state.modelSelector ?? (await settingsStore.get()).model.default ?? DEFAULT_MODEL;
      const title = fixed ?? await generateTaskTitle(model, ledger.state.objective, dataRoot);
      if (!title) return;
      await workbenchMeta.setAutoTitle(id, title);
      state.taskMeta = await workbenchMeta.all();
      const current = await currentLedger(id);
      if (current) emit({ type: "task", taskId: id, task: taskView(current) });
    })().catch(error => console.error("ALPHA_TASK_TITLE", id, error instanceof Error ? error.message : String(error)));
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

  const skillPluginStore = new SkillPluginStore(dataRoot);

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

  function serveUi(pathname: string): Response {
    const path = pathname === "/ui" || pathname === "/ui/" ? "/index.html" : pathname.slice(3);
    const file = resolve(uiRoot, `.${path}`);
    if (file !== uiRoot && !file.startsWith(uiRoot + sep)) return new Response("Forbidden", { status: 403 });
    const body = Bun.file(file);
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] ?? "application/octet-stream";
    return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
  }

  const webPermissions = new WebPermissionStore(dataRoot);
  return {
    appRoot, workspaceRoot, dataRoot, productsRoot, directBaselineRoot,
    settingsStore, skillPluginStore, workbenchMeta, projectStore, webPermissions,
    agentPresetStore: new AgentPresetStore(dataRoot),
    commandApprovals: commandApprovalStore(dataRoot),
    mcpPermissions: new MCPPermissionStore(dataRoot),
    operationJournal: new OperationJournal(dataRoot),
    taskQueue: new TaskQueueStore(dataRoot),
    automationStore: new AutomationStore(dataRoot),
    browserBridge,
    webKernel: new BrowserKernel(Number(process.env.ALPHA_CDP_PORT) || null, browserBridge),
    webRetrieval: new WebRetrieval(dataRoot, async (provider: WebProvider) => process.env[provider === "tavily" ? "TAVILY_API_KEY" : "FIRECRAWL_API_KEY"] ?? await browserBridge?.key(provider) ?? null),
    operations, browserLock: new BrowserLock(),
    /** Browser verifications in progress by task; a user takeover aborts them. */
    verifications: new Map<string, AbortController>(),
    /** Queue items and automation runs a model run was started for, by run id. */
    queuedRuns: new Map<string, string>(),
    automationRuns: new Map<string, string>(),
    clients, runs, previews, operationIds, state,
    runForTask, broadcast, emit, activityFor, setContext, appendActivity, flushText,
    loadLedger, currentLedger, listTasks, taskSnapshotList, taskRootAllowed, safeEvidencePath, safeArtifactPath, evidenceDetail,
    taskView, taskSummary, nameTask, pauseTasksForProjectChange, protectedPreviewIds, diagnostics,
    configuredRun, startOptions, selectedCapabilities, uploadedFiles, serveUi,
  };
}

export type ServerContext = Awaited<ReturnType<typeof createServerContext>>;
