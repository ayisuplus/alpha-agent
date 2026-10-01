import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { RpcProcess } from "./rpc-process";
import { OmpUpdateMonitor } from "./omp-update-monitor";
import { NativeConfiguration } from "./configuration";
import { buildLaunch, defaultWorkspaceRoot, persistedSessionId } from "./launch";
import { officeRuntimeStatus } from "./capabilities/office/office-runtime";
import { ComfyClient } from "./capabilities/comfyui/comfy-client";
import { ScheduleStore, Scheduler, type Schedule, type ScheduleDeliver } from "./scheduler";
import { projectReview } from "./project-review";
import { projectFilePreview, projectFileContent } from "./project-file";
import type { ExtensionCatalog, HostMethod } from "./host-types";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { resolveLocalRoot, resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ProjectSnapshots } from "./project-snapshots";
import { ProjectShells } from "./project-shells";
import { Projects } from "./projects";
import { projectSearch } from "./project-search";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";
import { AppUpdates } from "./app-updates";
import { openOfficeView, renderOfficeView, selectOfficeView, getOfficeView, closeOfficeView, isOfficeViewOpen } from "./capabilities/office/office-view";

interface SessionRecord {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  legacyTaskId?: string;
  /** The OMP session id captured from get_state; sessions resume explicitly via --resume. */
  ompSessionId?: string;
  /** Native branches share the original directory without moving their files. */
  sessionDirId?: string;
  archived?: boolean;
  tags?: string[];
}

const appRoot = resolve(import.meta.dir, "../..");
const workspaceRoot = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? appRoot);
const dataRoot = join(workspaceRoot, ".alpha");
const appUpdates = new AppUpdates(appRoot, workspaceRoot, JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")).version);
const sessionCwd = defaultWorkspaceRoot(workspaceRoot);
const nativeRoot = join(dataRoot, "native");
const indexPath = join(nativeRoot, "sessions.json");
const uiRoot = join(appRoot, "desktop", "dist");
const records = new Map<string, SessionRecord>();
const processes = new Map<string, Promise<RpcProcess>>();
const terminals = new Map<string, { pty: PtySession; output: string }>();
const streams = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();
const installedVersion = (JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@oh-my-pi/pi-coding-agent"];
const updates = new OmpUpdateMonitor(installedVersion, dataRoot);
const configuration = new NativeConfiguration();
const projects = new Projects(dataRoot);
const snapshots = new ProjectSnapshots(dataRoot, [getConfigRootDir(), configuration.agentDir]);
const shells = new ProjectShells(appRoot, dataRoot, (cwd, frame) => { for (const item of records.values()) if (item.cwd === cwd) emit(item.id, frame); });
const admissions = new Set<string>();
const taskQueues = new Map<string, Promise<unknown>>();
let saveQueue = Promise.resolve();
let hostQueue: Promise<unknown> = Promise.resolve();
const activity = new Map<string, { status: string; notice?: string; uiRequest?: Record<string, unknown>; planReviewStop?: boolean }>();

/** OMP process lifecycle: at most MAX_PROCESSES alive, idle ones reclaimed after IDLE_STOP_MS. */
const MAX_PROCESSES = 4;
const IDLE_STOP_MS = 10 * 60_000;
const lastUsed = new Map<string, number>();
const pendingReloads = new Set<string>();
const officeViews = new Map<string, { owner: string; used: number }>();
let openingOfficeViews = 0;
let extensionWrites: Promise<unknown> = Promise.resolve();
let extensionRevision = 0;
function touch(id: string): void { lastUsed.set(id, Date.now()); }

async function stopProcess(id: string, reason: string, restarting = false): Promise<void> {
  const pending = processes.get(id);
  if (!pending) return;
  processes.delete(id);
  lastUsed.delete(id);
  emit(id, { type: "host_exit", error: reason, restarting });
  const child = await pending.catch(() => null);
  await child?.stop();
}

async function enforceProcessCap(): Promise<void> {
  while (processes.size >= MAX_PROCESSES) {
    const ordered = [...processes.keys()].sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
    ordered.sort((a, b) => Number((streams.get(a)?.size ?? 0) > 0) - Number((streams.get(b)?.size ?? 0) > 0));
    let victim: string | undefined;
    for (const id of ordered) if (await reclaimable(await processes.get(id)!)) { victim = id; break; }
    if (!victim) throw new Error("4 个会话都在工作，请等待其中一个完成后再打开其他会话");
    await stopProcess(victim, "Alpha 已按最近使用回收内核进程");
  }
}

async function reclaimable(child: RpcProcess): Promise<boolean> {
  if (child.hasPendingWork) return false;
  const response = await child.command({ type: "get_state" }).catch(() => null);
  const state = response && "data" in response ? response.data : null;
  return !child.hasPendingWork && !!state && typeof state === "object" && "isSettled" in state && state.isSettled === true &&
    !("hasPendingAsyncWork" in state && state.hasPendingAsyncWork);
}
async function settleSnapshot(id: string, child: RpcProcess, outcome?: string) {
  if (admissions.has(id) || !await reclaimable(child)) return;
  await snapshots.finish(record(id).cwd, id, outcome ?? activity.get(id)?.status ?? "settled");
  emit(id, { type: "alpha_snapshot" });
}
async function admittedTask<T>(id: string, child: RpcProcess, execute: () => Promise<T>): Promise<T> {
  const operation = (taskQueues.get(id) ?? Promise.resolve()).then(async () => {
    admissions.add(id);
    try { await snapshots.begin(record(id).cwd, id); return await execute(); }
    finally { admissions.delete(id); await settleSnapshot(id, child).catch(error => emit(id, { type: "host_error", error: `Snapshot: ${String(error)}` })); }
  });
  taskQueues.set(id, operation.catch(() => undefined)); return operation;
}
async function projectIdle(cwd: string) {
  if (shells.busy(cwd) || [...terminals.keys()].some(id => record(id).cwd === cwd)) throw new Error("请先关闭该项目的终端");
  for (const [id, pending] of processes) if (record(id).cwd === cwd && (admissions.has(id) || !await reclaimable(await pending))) throw new Error("请等待该项目的所有任务真正结束");
}

async function reapIdleProcesses(): Promise<void> {
  const now = Date.now();
  for (const [id, view] of officeViews) if (now - view.used > IDLE_STOP_MS) { officeViews.delete(id); await closeOfficeView(id).catch(() => undefined); }
  for (const id of [...processes.keys()]) {
    if ((streams.get(id)?.size ?? 0) > 0) continue;
    if (now - (lastUsed.get(id) ?? 0) < IDLE_STOP_MS) continue;
    const pending = processes.get(id);
    if (!pending) continue;
    const child = await pending.catch(() => null);
    if (!child) { processes.delete(id); lastUsed.delete(id); continue; }
    if (!terminals.has(id) && await reclaimable(child)) await stopProcess(id, "Alpha 已停止空闲的内核进程");
  }
}
const reaper = setInterval(() => void reapIdleProcesses(), 60_000);
reaper.unref();

/** 定时任务投递：复用会话通道（/open + prompt）。目标为 new 时到点新建会话。 */
async function deliverSchedule(schedule: Schedule): ReturnType<ScheduleDeliver> {
  const target = schedule.target;
  const sessionId = target.kind === "session" ? target.sessionId : undefined;
  const item = sessionId ? record(sessionId) : await createSession(target.cwd ? { cwd: target.cwd, title: `定时任务 · ${schedule.name}` } : { title: `定时任务 · ${schedule.name}` });
  const child = await host(item.id);
  await schedules.beginRun(schedule.id, new Date(), item.id);
  if (!await reclaimable(child)) throw new Error(`目标会话「${item.title}」正在工作，本次跳过`);
  const accepted = await admittedTask(item.id, child, () => child.startPrompt(schedule.prompt));
  const receipt = await accepted.completion;
  if (receipt.status !== "completed") {
    const error = receipt.error as { message?: string } | undefined;
    return receipt.status === "aborted" ? { result: "任务已中止", status: "aborted" } : { result: `失败：${error?.message ?? "原生会话执行失败"}`, status: "failed" };
  }
  return `已完成 · 会话「${item.title}」`;
}

const schedules = new ScheduleStore(dataRoot);
const scheduler = new Scheduler(schedules, deliverSchedule);

await mkdir(nativeRoot, { recursive: true });
await writeFile(join(nativeRoot, "browser-control.json"), JSON.stringify({ paused: false }));
await mkdir(sessionCwd, { recursive: true });
const saved = await readFile(indexPath, "utf8").then(text => JSON.parse(text), () => ({ sessions: [] })).catch(() => ({ sessions: [] }));
for (const item of Array.isArray(saved.sessions) ? saved.sessions : []) if (typeof item?.id === "string" && /^[0-9a-f-]{36}$/.test(item.id)) records.set(item.id, item);
for (const cwd of new Set([...records.values()].map(item => item.cwd))) await projects.remember(cwd).catch(() => undefined);

function saveRecords(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    const temp = `${indexPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ sessions: [...records.values()] }, null, 2));
    await rename(temp, indexPath);
  });
  return saveQueue;
}

function syncIdentity(item: SessionRecord, id: unknown, title?: unknown): void {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || item.ompSessionId === id) return;
  if (item.ompSessionId) {
    const old = { ...item, id: randomUUID(), sessionDirId: item.sessionDirId ?? item.id };
    records.set(old.id, old);
  }
  item.ompSessionId = id;
  if (typeof title === "string" && title.trim()) item.title = title.trim().slice(0, 120);
  item.updatedAt = new Date().toISOString(); void saveRecords();
}
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** Local interface boundary: Host must be 127.0.0.1:<port> and /api requires the per-run token. */
const apiToken = process.env.ALPHA_SERVER_TOKEN ?? randomBytes(32).toString("hex");
const selfIssuedToken = !process.env.ALPHA_SERVER_TOKEN;

function authorized(request: Request, url: URL): boolean {
  return request.headers.get("x-alpha-token") === apiToken || url.searchParams.get("token") === apiToken;
}
function errorResponse(error: unknown, status = 400): Response {
  return json({ error: error instanceof Error ? error.message : String(error) }, status);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 12_000_000) throw new Error("Request too large");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value;
}
function record(id: string): SessionRecord {
  const found = records.get(id);
  if (!found) throw new Error("Session not found");
  return found;
}
async function sessionFile(id: string, input: string) {
  let root = record(id).cwd, path = input;
  if (path.startsWith("local://")) {
    const item = record(id), directory = join(nativeRoot, "sessions", item.sessionDirId ?? item.id);
    const file = item.ompSessionId && (await readdir(directory)).find(name => name.endsWith(`_${item.ompSessionId}.jsonl`));
    if (!file) throw new Error("Native session artifact directory unavailable");
    const options = { getArtifactsDir: () => join(directory, file.slice(0, -6)), getSessionId: () => item.ompSessionId! };
    root = resolveLocalRoot(options); path = resolveLocalUrlToPath(path, options);
  }
  return { root, path };
}
function emit(id: string, frame: unknown): void {
  const event = frame as Record<string, unknown>;
  const state = activity.get(id) ?? { status: "空闲" };
  if (event.type === "alpha_plan_stop") state.planReviewStop = event.interrupting === true;
  if (event.type === "alpha_plan" && event.phase === "review") state.status = "待审阅";
  if (event.type === "agent_start" || event.type === "tool_execution_start") state.status = "工作中";
  if (event.type === "host_command_start") state.status = "工作中";
  if (event.type === "host_command_end") state.status = event.error ? "失败" : "完成";
  if (event.type === "prompt_result") {
    const error = event.error as { message?: string } | undefined;
    state.status = event.status === "error" ? "失败" : event.status === "aborted" ? state.planReviewStop ? "待审阅" : "已中止" : event.sessionSettled === true ? "完成" : "工作中";
    delete state.planReviewStop;
    state.notice = error?.message;
  }
  if (event.type === "session_settled" && state.status === "工作中") state.status = "完成";
  if (event.type === "host_exit") { state.status = event.restarting ? "重新加载" : "未打开"; delete state.uiRequest; }
  if (event.type === "host_ready") state.status = "就绪";
  if (event.type === "extension_ui_request") {
    if (["select", "confirm", "input", "editor"].includes(String(event.method))) { state.uiRequest = event; state.status = "等待输入"; }
    if (event.method === "cancel") { delete state.uiRequest; state.status = "工作中"; }
    if (event.method === "notify") state.notice = String(event.message ?? "");
  }
  activity.set(id, state);
  const data = encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
  for (const controller of streams.get(id) ?? []) {
    try { controller.enqueue(data); } catch { streams.get(id)?.delete(controller); }
  }
}
async function host(id: string): Promise<RpcProcess> {
  const operation = hostQueue.then(() => openHost(id));
  hostQueue = operation.catch(() => undefined);
  return operation;
}
async function openHost(id: string): Promise<RpcProcess> {
  if (terminals.has(id)) throw new Error("Alpha 终端正在使用这个会话，请先关闭终端");
  const existing = processes.get(id);
  if (existing) { touch(id); return existing; }
  const item = record(id);
  const loadedRevision = extensionRevision;
  await enforceProcessCap();
  touch(id);
  const pending = (async () => {
    if (!(await stat(item.cwd)).isDirectory()) throw new Error(`Project directory unavailable: ${item.cwd}`);
    const dir = join(nativeRoot, "sessions", item.sessionDirId ?? id);
    await mkdir(dir, { recursive: true });
    const ompSessionId = await persistedSessionId(dir, item.ompSessionId);
    if (!ompSessionId) delete item.ompSessionId;
    const plan = await buildLaunch({ appRoot, cwd: item.cwd, sessionDir: dir, sessionId: id, dataRoot, mode: "rpc", ...(ompSessionId ? { ompSessionId } : {}) });
    const child = new RpcProcess({ cwd: item.cwd, argv: plan.argv, env: plan.env });
    child.on("frame", frame => {
      if (frame.type === "alpha_plan" || frame.type === "session_info_update") syncIdentity(item, frame.sessionId, frame.title);
      if (frame.type === "session_info_update" && typeof frame.title === "string" && frame.title.trim()) {
        item.title = frame.title.trim().slice(0, 120);
        void saveRecords();
      }
      emit(id, frame);
      if (frame.type === "session_settled" || frame.type === "prompt_result") void settleSnapshot(id, child).catch(error => emit(id, { type: "host_error", error: `Snapshot: ${String(error)}` }));
    });
    child.on("exit", error => {
      if (processes.delete(id) && !terminals.has(id)) emit(id, { type: "host_exit", error: error.message });
      void snapshots.finish(item.cwd, id, "interrupted").catch(error => emit(id, { type: "host_error", error: `Snapshot: ${String(error)}` }));
    });
    child.on("protocol_error", error => emit(id, { type: "host_error", error: String(error) }));
    await child.ready;
    await child.command({ type: "negotiate_protocol", protocolVersion: 2 });
    await child.command({ type: "set_subagent_subscription", level: "progress" });
    if (loadedRevision === extensionRevision) pendingReloads.delete(id);
    if (!ompSessionId) {
      const state = await child.command({ type: "get_state" });
      const data = "data" in state ? state.data : null;
      const ompSessionId = data && typeof data === "object" && "sessionId" in data ? data.sessionId : undefined;
      const sessionName = data && typeof data === "object" && "sessionName" in data ? data.sessionName : undefined;
      if (typeof ompSessionId === "string" && ompSessionId) {
        item.ompSessionId = ompSessionId;
        if (typeof sessionName === "string" && sessionName.trim()) item.title = sessionName.trim().slice(0, 120);
        item.updatedAt = new Date().toISOString();
        void saveRecords();
      }
    }
    emit(id, { type: "host_ready" });
    return child;
  })();
  processes.set(id, pending);
  try { return await pending; }
  catch (error) { processes.delete(id); emit(id, { type: "host_exit", error: String(error) }); throw error; }
}
/** Terminal sessions own their OMP process; recover the OMP session id from the session file header. */
async function captureTerminalSession(id: string, sessionDir: string, since: number, once = false): Promise<void> {
  do {
    const { promise: tick, resolve: wake } = Promise.withResolvers<void>();
    setTimeout(wake, 1_000);
    await tick;
    const item = records.get(id);
    if (!item) return;
    const files = await readdir(sessionDir).catch(() => [] as string[]);
    const journals = await Promise.all(files.filter(name => name.endsWith(".jsonl")).map(async name => ({ name, time: (await stat(join(sessionDir, name))).mtimeMs })));
    for (const { name, time } of journals.sort((a, b) => b.time - a.time)) {
      if (time < since) continue;
      const loaded = await loadSessionFile(join(sessionDir, name)).catch(() => null), header = loaded?.entries[0];
      if (header?.type === "session" && typeof header.id === "string" && header.id) {
        const title = loaded?.titleSlot?.title ?? header.title;
        syncIdentity(item, header.id, title);
        if (typeof title === "string" && title.trim()) item.title = title.trim().slice(0, 120);
        item.updatedAt = new Date().toISOString();
        void saveRecords();
        break;
      }
    }
  } while (!once && terminals.has(id));
}

async function createSession(input: { cwd?: unknown; title?: unknown; legacyTaskId?: string }): Promise<SessionRecord> {
  const cwd = await realpath(resolve(typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : sessionCwd));
  if (!(await stat(cwd)).isDirectory()) throw new Error("Project directory does not exist");
  const now = new Date().toISOString();
  const item: SessionRecord = { id: randomUUID(), cwd, title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 120) : basename(cwd),
    createdAt: now, updatedAt: now, ...(input.legacyTaskId ? { legacyTaskId: input.legacyTaskId } : {}) };
  records.set(item.id, item);
  await saveRecords();
  await projects.remember(cwd);
  return item;
}
async function legacy(id: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid legacy task id");
  const value = JSON.parse(await readFile(join(dataRoot, "tasks", `${id}.json`), "utf8"));
  const state = value?.state?.objective ? value.state : value;
  if (!state?.objective) throw new Error("Legacy task record is invalid");
  return state;
}
async function legacyList(): Promise<unknown[]> {
  const names = (await readdir(join(dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  const items = await Promise.all(names.map(async name => {
    try {
      const state = await legacy(name.slice(0, -5));
      return { id: name.slice(0, -5), title: String(state.title ?? state.objective).slice(0, 100), status: state.status, objective: state.objective };
    } catch { return null; }
  }));
  return items.filter(item => item !== null);
}
function continuationDraft(state: Record<string, unknown>): string {
  const evidence = Array.isArray(state.evidence) ? state.evidence.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  const refs = evidence.slice(-12).map(item => `- ${String(item.kind ?? "evidence")}: ${String(item.source ?? "")} (${item.passed === true ? "passed" : "unverified"})`);
  return `继续这个旧 Alpha 任务。请先核实文件和当前状态，再按下面的原始目标工作。旧记录只作为线索，不代表当前验证已通过。\n\n目标：${String(state.objective)}\n旧状态：${String(state.status ?? "unknown")}\n项目路径：${String(state.projectRoot ?? "unknown")}\n证据与产物引用：\n${refs.length ? refs.join("\n") : "- 无"}`;
}
function uiFile(pathname: string): Response {
  const part = pathname === "/ui" || pathname === "/ui/" ? "index.html" : pathname.slice(4);
  const target = resolve(uiRoot, part);
  if (target !== uiRoot && !target.startsWith(`${uiRoot}${sep}`)) return new Response("Forbidden", { status: 403 });
  if (!existsSync(target)) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(target), { headers: { "cache-control": part === "index.html" ? "no-cache" : "public, max-age=3600" } });
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 120,
  async fetch(request, nativeServer) {
    const url = new URL(request.url);
    const origin = `http://127.0.0.1:${server.port}`;
    if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
    if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") && request.headers.get("origin") !== origin) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/health") return json({ ok: true, engine: "omp-native" });
    if (url.pathname.startsWith("/ui")) return uiFile(url.pathname);
    if (url.pathname.startsWith("/api") && !authorized(request, url)) return json({ error: "Forbidden" }, 403);
    try {
      if (url.pathname === "/api/native/app-updates" && request.method === "GET") return json(await appUpdates.status());
      if (url.pathname === "/api/native/app-updates" && request.method === "POST") {
        const input = await body(request);
        if (input.action === "source") return json(await appUpdates.configure(input.source));
        if (input.action === "check") return json(await appUpdates.check());
        if (input.action === "cancel") return json(await appUpdates.cancel());
        if (input.action === "prepare") { nativeServer.timeout(request, 0); return json(await appUpdates.prepare({ path: typeof input.path === "string" ? input.path : undefined })); }
        if (input.action === "install") {
          for (const child of processes.values()) if (!await reclaimable(await child)) throw new Error("Wait for all native sessions to settle before restarting");
          if (!process.env.ALPHA_DESKTOP_PID || !process.env.ALPHA_DESKTOP_EXECUTABLE) throw new Error("Update installation requires the desktop app");
          return json(await appUpdates.handoff(input.id, { parentPid: Number(process.env.ALPHA_DESKTOP_PID), executable: process.env.ALPHA_DESKTOP_EXECUTABLE, args: JSON.parse(process.env.ALPHA_DESKTOP_ARGS ?? "[]") }));
        }
        throw new Error("Unknown application update action");
      }
      if (url.pathname === "/api/native/configuration" && request.method === "GET") {
        const id = url.searchParams.get("sessionId");
        return json(id ? await (await host(id)).hostCommand("configuration") : await configuration.read());
      }
      if (url.pathname === "/api/native/projects") {
        if (request.method === "GET") return json({ projects: await projects.list() });
        if (request.method === "POST") {
          const input = await body(request);
          if (input.action === "add" && typeof input.cwd === "string") return json({ project: await projects.remember(input.cwd) });
          if (input.action === "remove") {
            const project = (await projects.list()).find(item => item.id === input.id); if (!project) throw new Error("Project not found");
            if (project.managed) {
              if (!project.source || project.source === project.cwd || await realpath(project.cwd) !== project.cwd) throw new Error("Managed worktree identity changed; removal stopped");
              await projectIdle(project.cwd);
              const repository = requireGit(project.source), worktrees = await repository.worktrees();
              if (!worktrees.some(item => resolve(item.path).toLowerCase() === project.cwd.toLowerCase()) || repository.info().repoRoot.toLowerCase() === project.cwd.toLowerCase()) throw new Error("Managed worktree no longer matches its source repository");
              const review = await projectReview(project.cwd);
              if (!review.available || review.status.trim()) throw new Error("工作树有暂存、未暂存或未跟踪改动，已停止清理");
              for (const [id] of processes) if (record(id).cwd === project.cwd) await stopProcess(id, "正在移除工作树");
              if ((await projectReview(project.cwd)).status.trim()) throw new Error("工作树发生后续变动，已停止清理");
              await repository.worktreeRemove(project.cwd, false);
            }
            await projects.remove(project.id); return json({ removed: true });
          }
          throw new Error("Unsupported project operation");
        }
      }
      if (url.pathname === "/api/native/models" && request.method === "GET") {
        const id = url.searchParams.get("sessionId");
        return json(id ? await (await host(id)).hostCommand("configuration", { action: "models" }) : await configuration.catalog());
      }
      if (url.pathname === "/api/native/provider-config") {
        if (request.method === "GET") return json(await configuration.providers());
        if (request.method === "POST") {
          const input = await body(request);
          const operation = extensionWrites.then(async () => {
            const result = await configuration.providers(input);
            for (const id of processes.keys()) pendingReloads.add(id);
            return json({ ...result, pendingReload: processes.size > 0 });
          });
          extensionWrites = operation.catch(() => undefined);
          return await operation;
        }
      }
      if (url.pathname === "/api/native/settings" && request.method === "POST") {
        const input = await body(request);
        const operation = extensionWrites.then(async () => {
          const result = typeof input.sessionId === "string"
            ? await (await host(input.sessionId)).hostCommand("configuration", { ...input, action: "save" })
            : await configuration.update(input);
          for (const id of processes.keys()) if (id !== input.sessionId && (input.scope !== "project" || record(id).cwd === record(String(input.sessionId)).cwd)) pendingReloads.add(id);
          return json(result);
        });
        extensionWrites = operation.catch(() => undefined);
        return await operation;
      }
      if (url.pathname === "/api/native/credentials" && request.method === "POST") {
        const input = await body(request);
        const operation = extensionWrites.then(async () => {
          await configuration.credential(input);
          const pending: string[] = [];
          for (const [id, process] of processes) {
            const child = await process;
            if (await reclaimable(child)) await child.hostCommand("configuration", { action: "reload" });
            else { pendingReloads.add(id); pending.push(id); }
          }
          return json({ saved: true, pendingReload: pending.length > 0 });
        });
        extensionWrites = operation.catch(() => undefined);
        return await operation;
      }
      if (url.pathname === "/api/native/updates" && request.method === "GET") return json(updates.status());
      if (url.pathname === "/api/native/capabilities" && request.method === "GET") {
        const [office, comfyOk] = await Promise.all([officeRuntimeStatus().catch(error => ({ available: false as const, reason: String(error) })),
          new ComfyClient(process.env.ALPHA_COMFY_URL).health().catch(() => false)]);
        return json({ office, comfy: { available: comfyOk, url: process.env.ALPHA_COMFY_URL ?? "http://127.0.0.1:8188", ...(comfyOk ? {} : { reason: "本机未检测到 ComfyUI 服务" }) } });
      }
      if (url.pathname === "/api/native/skills" && request.method === "GET") {
        const root = join(appRoot, "presets", "alpha-plugin", "skills");
        const names = await readdir(root).catch(() => [] as string[]);
        const skills = await Promise.all(names.sort().map(async name => {
          const text = await readFile(join(root, name, "SKILL.md"), "utf8").catch(() => "");
          const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
          return { name, description };
        }));
        return json({ skills: skills.filter(skill => skill.description) });
      }
      if (url.pathname === "/api/native/schedules" && request.method === "GET") return json({ schedules: await schedules.list() });
      if (url.pathname === "/api/native/schedules" && request.method === "POST") return json({ schedule: await schedules.create(await body(request)) }, 201);
      const scheduleMatch = /^\/api\/native\/schedules\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (scheduleMatch) {
        const [, id] = scheduleMatch;
        if (request.method === "POST") return json({ schedule: await schedules.update(id, await body(request)) });
        if (request.method === "DELETE") { await schedules.remove(id); return json({ removed: true }); }
      }
      if (url.pathname === "/api/native/updates/check" && request.method === "POST") return json(await updates.check());
      if (url.pathname === "/api/native/updates/dismiss" && request.method === "POST") {
        const input = await body(request);
        if (typeof input.version !== "string") throw new Error("Missing version");
        await updates.dismiss(input.version);
        return json(updates.status());
      }
      if (url.pathname === "/api/native/updates/notified" && request.method === "POST") {
        const input = await body(request);
        if (typeof input.version !== "string") throw new Error("Update version required");
        await updates.markNotified(input.version);
        return json(updates.status());
      }
      if (url.pathname === "/api/native/sessions") {
        if (request.method === "GET") {
          const query = url.searchParams.get("search")?.trim().toLowerCase();
          let sessions = [...records.values()]; const errors: Array<{ id: string; error: string }> = [];
          if (query) {
            const found: SessionRecord[] = [];
            for (const item of sessions) {
              if (`${item.title} ${item.cwd} ${item.tags?.join(" ")}`.toLowerCase().includes(query)) { found.push(item); continue; }
              if (!item.ompSessionId) continue;
              try {
                const directory = join(nativeRoot, "sessions", item.sessionDirId ?? item.id);
                const file = (await readdir(directory)).find(name => name.endsWith(`_${item.ompSessionId}.jsonl`));
                if (!file) continue;
                const loaded = await loadSessionFile(join(directory, file));
                if (loaded.entries.some(entry => entry.type === "message" && JSON.stringify(entry.message).toLowerCase().includes(query))) found.push(item);
                if (loaded.malformedRecords || loaded.invalidHeader) errors.push({ id: item.id, error: "Native session contains malformed records" });
              } catch (error) { errors.push({ id: item.id, error: String(error) }); }
            }
            sessions = found;
          }
          return json({ sessions: sessions.map(item => ({ ...item, ...(activity.get(item.id) ?? { status: "未打开" }) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), errors });
        }
        if (request.method === "POST") return json({ session: await createSession(await body(request)) }, 201);
      }
      const meta = /^\/api\/native\/sessions\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (meta && request.method === "POST") {
        const item = record(meta[1]);
        const input = await body(request);
        if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(tag => typeof tag !== "string" || tag.length > 40))) throw new Error("Invalid session tags");
        if (typeof input.title === "string" && (!input.title.trim() || input.title.trim().length > 120)) throw new Error("会话名称需要 1–120 个字符");
        if (typeof input.archived === "boolean") item.archived = input.archived;
        if (typeof input.title === "string") {
          const child = await host(item.id);
          await child.command({ type: "set_session_name", name: input.title.trim() });
          item.title = input.title.trim();
        }
        if (input.tags !== undefined) {
          item.tags = [...new Set((input.tags as string[]).map(tag => tag.trim()).filter(Boolean))];
        }
        item.updatedAt = new Date().toISOString();
        await saveRecords();
        return json({ session: item });
      }
      if (url.pathname === "/api/native/browser-control" && request.method === "POST") {
        const input = await body(request);
        await writeFile(join(nativeRoot, "browser-control.json"), JSON.stringify({ paused: input.paused === true }));
        return json({ paused: input.paused === true });
      }
      if (url.pathname === "/api/native/legacy" && request.method === "GET") return json({ tasks: await legacyList() });
      const exported = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/export$/.exec(url.pathname);
      if (exported && request.method === "POST") {
        const item = record(exported[1]), child = await host(item.id);
        const directory = join(nativeRoot, "exports"); await mkdir(directory, { recursive: true });
        const path = join(directory, `${item.id}.html`);
        await child.command({ type: "export_html", outputPath: path });
        return json({ name: `${item.title.replace(/[<>:"/\\|?*]/g, "_")}.html`, content: await readFile(path, "utf8") });
      }
      const controls = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/host\/(catalog|extension|mode|plan|tree|navigate|usage|reload|session|worktree|configuration|definitions)$/.exec(url.pathname);
      if (controls) {
        const [, id, method] = controls;
        record(id);
        let child = await host(id);
        if (method === "reload" && request.method === "POST") {
          if (!await reclaimable(child)) return json({ pendingReload: true });
          await stopProcess(id, "正在重新加载扩展", true); child = await host(id);
          pendingReloads.delete(id);
          return json(await child.hostCommand("catalog"));
        }
        if (request.method === "GET" && ["catalog", "mode", "tree", "usage", "configuration"].includes(method)) {
          const result = await child.hostCommand(method as HostMethod);
          return json(method === "catalog" ? { ...result as ExtensionCatalog, pendingReload: pendingReloads.has(id) } : result);
        }
        if (request.method === "POST" && ["extension", "plan", "navigate", "session", "worktree", "definitions"].includes(method)) {
          const input = await body(request);
          const execute = async () => {
            child = await host(id);
            const perform = () => child.hostCommand(method as HostMethod, input, method === "plan" ? 300_000 : 90_000);
            const result = await (method === "plan" && input.action === "approve" ? admittedTask(id, child, perform) : perform()) as { pendingReload?: boolean; path?: string; branch?: string };
            if (method === "worktree" && input.action === "create" && result.path) await projects.remember(result.path, { source: record(id).cwd, branch: result.branch, managed: true });
            if (method === "session" && input.action === "branch") {
              const state = await child.command({ type: "get_state" });
              if ("data" in state) { const current = state.data as { sessionId: string; sessionName?: string }; syncIdentity(record(id), current.sessionId, current.sessionName); }
              await saveRecords();
            }
            if (["extension", "definitions"].includes(method) && result.pendingReload) {
              extensionRevision++;
              for (const target of processes.keys()) if (input.scope !== "project" || input.kind === "plugin" || record(target).cwd === record(id).cwd) pendingReloads.add(target);
              if (await reclaimable(child)) {
                await stopProcess(id, "正在重新加载扩展", true); child = await host(id);
                const catalog = await child.hostCommand("catalog") as ExtensionCatalog;
                return json({ ...result, pendingReload: false, catalog });
              }
            }
            return json(result);
          };
          if (!["extension", "definitions"].includes(method)) return await execute();
          const operation = extensionWrites.then(execute);
          extensionWrites = operation.catch(() => undefined);
          return await operation;
        }
        throw new Error("Unsupported host operation");
      }
      const projectControl = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/(search|snapshots|shells)(?:\/([0-9a-f-]{36})\/(input|resize|close))?$/.exec(url.pathname);
      if (projectControl) {
        const [, id, action, shellId, shellAction] = projectControl, cwd = record(id).cwd;
        if (action === "search" && request.method === "GET") return json(await projectSearch(cwd, url.searchParams.get("q") ?? "", url.searchParams.get("content") === "1", request.signal));
        if (action === "shells") {
          if (request.method === "GET" && !shellId) return json({ shells: shells.list(cwd) });
          if (request.method === "POST") { const input = await body(request); return json(shellId ? shells.request(cwd, shellId, shellAction, input) : await shells.create(cwd, typeof input.name === "string" ? input.name : undefined)); }
        }
        if (action === "snapshots") {
          if (request.method === "GET") return json(await snapshots.list(cwd));
          const input = await body(request); if (typeof input.id !== "string") throw new Error("Snapshot ID required");
          if (input.action === "preview") return json(await snapshots.preview(cwd, input.id, input.redo === true));
          if (input.action === "restore") { await projectIdle(cwd); return json(await snapshots.restore(cwd, input.id, input.redo === true)); }
        }
        throw new Error("Unsupported project operation");
      }
      const terminalMatch = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/terminal(?:\/(start|input|resize|stop))?$/.exec(url.pathname);
      if (terminalMatch) {
        const [, id, action] = terminalMatch;
        const item = record(id);
        if (!action && request.method === "GET") return json({ active: terminals.has(id), output: terminals.get(id)?.output ?? "" });
        if (action === "start" && request.method === "POST") {
          if (terminals.has(id)) throw new Error("Alpha 终端已经打开");
          const sessionDir = join(nativeRoot, "sessions", item.sessionDirId ?? id);
          await mkdir(sessionDir, { recursive: true });
          const ompSessionId = await persistedSessionId(sessionDir, item.ompSessionId);
          const running = processes.get(id);
          if (running) {
            const rpc = await running;
            const state = await rpc.command({ type: "get_state" });
            const data = "data" in state ? state.data : null;
            const settled = data && typeof data === "object" ? data : {};
            if (rpc.hasPendingWork || !("isSettled" in settled) || !settled.isSettled || ("hasPendingAsyncWork" in settled && settled.hasPendingAsyncWork)) throw new Error("请等待会话完成后再打开原生终端");
            processes.delete(id);
            lastUsed.delete(id);
            await rpc.stop();
          }
          if (!ompSessionId) { delete item.ompSessionId; await saveRecords(); }
          const input = await body(request);
          const cols = Math.max(40, Math.min(240, Number(input.cols) || 100));
          const rows = Math.max(12, Math.min(100, Number(input.rows) || 30));
          const pty = new PtySession();
          await snapshots.begin(item.cwd, id);
          const terminal = { pty, output: "" };
          terminals.set(id, terminal);
          const plan = await buildLaunch({ appRoot, cwd: item.cwd, sessionDir, sessionId: id, dataRoot, agentDir: configuration.agentDir,
            mode: "terminal", terminalTheme: await configuration.themeUnset(), ...(ompSessionId ? { ompSessionId } : {}) });
          const started = Date.now();
          void captureTerminalSession(id, sessionDir, started).catch(error => emit(id, { type: "host_error", error: String(error) }));
          const finishTerminal = async (exitCode?: number) => {
            await captureTerminalSession(id, sessionDir, started, true).catch(error => emit(id, { type: "host_error", error: String(error) }));
            await snapshots.finish(item.cwd, id, "terminal-exit").catch(error => emit(id, { type: "host_error", error: `Snapshot: ${String(error)}` }));
            terminals.delete(id); emit(id, { type: "terminal_exit", exitCode });
            void host(id).catch(error => emit(id, { type: "host_error", error: String(error) }));
          };
          void pty.startArgv({ application: process.execPath, args: plan.argv, cwd: item.cwd, env: plan.env, cols, rows }, (error, chunk) => {
            if (error) emit(id, { type: "terminal_error", error: error.message });
            if (chunk) { terminal.output = (terminal.output + chunk).slice(-100_000); emit(id, { type: "terminal_chunk", chunk }); }
          }).then(result => finishTerminal(result.exitCode), async error => { emit(id, { type: "terminal_error", error: String(error) }); await finishTerminal(); });
          emit(id, { type: "terminal_start" });
          return json({ active: true });
        }
        const terminal = terminals.get(id);
        if (!terminal) throw new Error("Native terminal is not open");
        if (action === "input" && request.method === "POST") {
          const input = await body(request);
          if (typeof input.data !== "string" || input.data.length > 10_000) throw new Error("Invalid terminal input");
          terminal.pty.write(input.data);
          return json({ accepted: true });
        }
        if (action === "resize" && request.method === "POST") {
          const input = await body(request);
          terminal.pty.resize(Math.max(40, Math.min(240, Number(input.cols) || 100)), Math.max(12, Math.min(100, Number(input.rows) || 30)));
          return json({ accepted: true });
        }
        if (action === "stop" && request.method === "POST") { terminal.pty.kill(); return json({ accepted: true }); }
      }
      const oldTask = /^\/api\/native\/legacy\/([0-9a-f-]{36})(?:\/(continue))?$/.exec(url.pathname);
      if (oldTask && request.method === "GET" && !oldTask[2]) return json({ task: await legacy(oldTask[1]) });
      if (oldTask && request.method === "POST" && oldTask[2]) {
        const state = await legacy(oldTask[1]);
        const preferred = typeof state.projectRoot === "string" ? state.projectRoot : workspaceRoot;
        const cwd = await stat(preferred).then(info => info.isDirectory() ? preferred : workspaceRoot, () => workspaceRoot);
        const session = await createSession({ cwd, title: String(state.title ?? state.objective).slice(0, 120), legacyTaskId: oldTask[1] });
        return json({ session, draft: continuationDraft(state) }, 201);
      }
      const consentMatch = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/browser-consent$/.exec(url.pathname);
      if (consentMatch && (request.method === "GET" || request.method === "DELETE")) {
        const [, id] = consentMatch;
        record(id);
        const file = join(dataRoot, "native", "browser-consents", `${id}.json`);
        const entries = await readFile(file, "utf8").then(text => JSON.parse(text) as Record<string, unknown>, () => ({}) as Record<string, unknown>);
        if (request.method === "GET") return json({ consent: entries[id] ?? null });
        delete entries[id];
        await mkdir(join(nativeRoot, "browser-consents"), { recursive: true });
        await writeFile(file, JSON.stringify(entries, null, 2), "utf8");
        return json({ revoked: true });
      }
      const officeMatch = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/office-view$/.exec(url.pathname);
      if (officeMatch && request.method === "POST") {
        const id = officeMatch[1]!; record(id);
        const input = await body(request);
        if (input.action === undefined || input.action === "open") {
          if (typeof input.path !== "string") throw new Error("缺少 Office 文件路径");
          const { root, path } = await sessionFile(id, input.path);
          const file = await projectFilePreview(root, path);
          if (file.kind !== "office") throw new Error("请选择 50 MB 以内的 Office 文档");
          for (const key of officeViews.keys()) if (!isOfficeViewOpen(key)) officeViews.delete(key);
          if (officeViews.size + openingOfficeViews >= 4) throw new Error("请先关闭一个 Office 预览，再打开新文档");
          openingOfficeViews++;
          try {
            nativeServer.timeout(request, 40);
            const info = await openOfficeView(file.path, request.signal);
            officeViews.set(info.id, { owner: id, used: Date.now() }); return json(info);
          } finally { openingOfficeViews--; }
        }
        const viewId = typeof input.viewId === "string" ? input.viewId : "";
        const view = officeViews.get(viewId);
        if (!view || view.owner !== id) throw new Error("此原格式预览不属于当前会话，或已经关闭");
        view.used = Date.now();
        if (input.action === "close") { officeViews.delete(viewId); await closeOfficeView(viewId); return json({ closed: true }); }
        if (input.action === "info") return json(await getOfficeView(viewId));
        // Worker validates types, bounds and part indices; only its read-only actions are exposed.
        const { action, viewId: ignored, ...options } = input;
        if (action === "render") return json(await renderOfficeView(viewId, options));
        if (action === "select") return json(await selectOfficeView(viewId, options as unknown as Parameters<typeof selectOfficeView>[1]));
        throw new Error("Unsupported Office preview action");
      }
      const match = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/(state|messages|models|files|file|review|events|command|ui-response|open)$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        record(id);
        if (action === "file" && request.method === "GET") {
          const input = url.searchParams.get("path");
          if (!input) throw new Error("缺少文件路径");
          const { root, path } = await sessionFile(id, input);
          return url.searchParams.has("raw")
            ? await projectFileContent(root, path, request, url.searchParams.has("preview"))
            : json(await projectFilePreview(root, path));
        }
        if (action === "review" && request.method === "GET") return json(await projectReview(record(id).cwd));
        if (action === "open" && request.method === "POST") {
          await host(id);
          return json({ open: true });
        }
        if (action === "files" && request.method === "GET") {
          const root = await realpath(record(id).cwd);
          const path = await realpath(resolve(root, url.searchParams.get("path") ?? "."));
          const part = relative(root, path);
          if (part === ".." || part.startsWith(`..${sep}`) || resolve(root, part) !== path) throw new Error("只能浏览会话项目目录内的文件");
          const directory = await readdir(path, { withFileTypes: true });
          const files = await Promise.all(directory.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map(async item => ({
            name: item.name, type: item.isDirectory() ? "directory" : "file",
            path: join(path, item.name),
            size: item.isFile() ? await stat(join(path, item.name)).then(info => info.size, () => 0) : undefined,
          })));
          return json({ path, relative: part, files });
        }
        if (action === "events" && request.method === "GET") {
          nativeServer.timeout(request, 0);
          let currentController: ReadableStreamDefaultController<Uint8Array> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              currentController = controller;
              const clients = streams.get(id) ?? new Set();
              clients.add(controller);
              streams.set(id, clients);
              controller.enqueue(encoder.encode(": connected\n\n"));
              const pending = activity.get(id)?.uiRequest;
              if (pending) controller.enqueue(encoder.encode(`data: ${JSON.stringify(pending)}\n\n`));
            },
            cancel() { if (currentController) streams.get(id)?.delete(currentController); },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
        }
        const running = processes.get(id);
        if (!running) return json({ error: "Session process is not open" }, 409);
        const process = await running;
        touch(id);
        if (action === "state" && request.method === "GET") { const result = await process.command({ type: "get_state" }); return json("data" in result ? result.data : null); }
        if (action === "messages" && request.method === "GET") { const result = await process.command({ type: "get_messages" }); return json("data" in result ? result.data : null); }
        if (action === "models" && request.method === "GET") { const result = await process.command({ type: "get_available_models" }); return json("data" in result ? result.data : null); }
        if (action === "command" && request.method === "POST") {
          const input = await body(request);
          if (typeof input.type !== "string" || ["set_host_tools", "set_host_uri_schemes", "set_event_filter"].includes(input.type)) throw new Error("Unsupported desktop command");
          const work = ["compact", "login", "bash", "handoff"].includes(input.type);
          if (work) emit(id, { type: "host_command_start" });
          let response;
          try {
            const execute = () => process.command(input as unknown as RpcCommand, work ? 300_000 : 30_000);
            response = await (["prompt", "steer", "follow_up", "abort_and_prompt", "bash", "handoff"].includes(input.type) ? admittedTask(id, process, execute) : execute());
            if (work && await reclaimable(process)) emit(id, { type: "host_command_end" });
          } catch (error) {
            if (work && await reclaimable(process)) emit(id, { type: "host_command_end", error: String(error) });
            throw error;
          }
          const item = record(id);
          if (["new_session", "branch", "switch_session"].includes(input.type)) {
            const current = await process.command({ type: "get_state" });
            if ("data" in current) { const state = current.data as { sessionId?: string; sessionName?: string }; syncIdentity(item, state.sessionId, state.sessionName); }
          }
          item.updatedAt = new Date().toISOString();
          if (input.type === "set_session_name" && typeof input.name === "string") item.title = input.name.trim().slice(0, 120);
          void saveRecords();
          return json(response);
        }
        if (action === "ui-response" && request.method === "POST") {
          const input = await body(request);
          if (input.type !== "extension_ui_response" || typeof input.id !== "string") throw new Error("Invalid OMP UI response");
          process.sendFrame(input);
          const active = activity.get(id);
          if (active?.uiRequest?.id === input.id) { delete active.uiRequest; active.status = "工作中"; }
          return json({ accepted: true });
        }
      }
      return new Response("Not found", { status: 404 });
    } catch (error) { return errorResponse(error); }
  },
});

console.log(`ALPHA_SERVER_READY ${server.port}`);
if (selfIssuedToken) console.log(`ALPHA_SERVER_TOKEN ${apiToken}`);
void updates.start();
await schedules.recoverInterrupted();
scheduler.start();
process.on("SIGINT", () => {
  for (const id of officeViews.keys()) void closeOfficeView(id);
  scheduler.stop();
  for (const terminal of terminals.values()) terminal.pty.kill();
  shells.stop();
  for (const pending of processes.values()) void pending.then(child => child.stop(), () => undefined);
  server.stop(true);
});
