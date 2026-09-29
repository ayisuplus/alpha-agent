import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { RpcProcess } from "./rpc-process";
import { OmpUpdateMonitor } from "./omp-update-monitor";

interface SessionRecord {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  legacyTaskId?: string;
}

const appRoot = resolve(import.meta.dir, "../..");
const workspaceRoot = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? appRoot);
const dataRoot = join(workspaceRoot, ".alpha");
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
await updates.start();
let saveQueue = Promise.resolve();

await mkdir(nativeRoot, { recursive: true });
const saved = await readFile(indexPath, "utf8").then(text => JSON.parse(text), () => ({ sessions: [] })).catch(() => ({ sessions: [] }));
for (const item of Array.isArray(saved.sessions) ? saved.sessions : []) if (typeof item?.id === "string" && /^[0-9a-f-]{36}$/.test(item.id)) records.set(item.id, item);

function saveRecords(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    const temp = `${indexPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ sessions: [...records.values()] }, null, 2));
    await rename(temp, indexPath);
  });
  return saveQueue;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
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
function emit(id: string, frame: unknown): void {
  const data = encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
  for (const controller of streams.get(id) ?? []) {
    try { controller.enqueue(data); } catch { streams.get(id)?.delete(controller); }
  }
}
async function host(id: string): Promise<RpcProcess> {
  if (terminals.has(id)) throw new Error("Native terminal owns this session; close it before using RPC");
  const existing = processes.get(id);
  if (existing) return existing;
  const item = record(id);
  const pending = (async () => {
    if (!(await stat(item.cwd)).isDirectory()) throw new Error(`Project directory unavailable: ${item.cwd}`);
    const dir = join(nativeRoot, "sessions", id);
    const resume = (await readdir(dir).catch(() => [] as string[])).some(name => name.endsWith(".jsonl"));
    await mkdir(dir, { recursive: true });
    const child = new RpcProcess({ appRoot, cwd: item.cwd, sessionDir: dir, sessionId: id, dataRoot,
      cognitionFile: join(nativeRoot, "cognition", `${id}.json`), resume });
    child.on("frame", frame => emit(id, frame));
    child.on("exit", error => { processes.delete(id); if (!terminals.has(id)) emit(id, { type: "host_exit", error: error.message }); });
    child.on("protocol_error", error => emit(id, { type: "host_error", error: String(error) }));
    await child.ready;
    await child.command({ type: "negotiate_protocol", protocolVersion: 2 });
    return child;
  })();
  processes.set(id, pending);
  try { return await pending; }
  catch (error) { processes.delete(id); throw error; }
}
async function createSession(input: { cwd?: unknown; title?: unknown; legacyTaskId?: string }): Promise<SessionRecord> {
  const cwd = resolve(typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : workspaceRoot);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Project directory does not exist");
  const now = new Date().toISOString();
  const item: SessionRecord = { id: randomUUID(), cwd, title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 120) : basename(cwd),
    createdAt: now, updatedAt: now, ...(input.legacyTaskId ? { legacyTaskId: input.legacyTaskId } : {}) };
  records.set(item.id, item);
  await saveRecords();
  return item;
}
async function legacy(id: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid legacy task id");
  const value = JSON.parse(await readFile(join(dataRoot, "tasks", `${id}.json`), "utf8"));
  if (!value?.state?.objective) throw new Error("Legacy task record is invalid");
  return value.state;
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
  async fetch(request) {
    const url = new URL(request.url);
    const origin = `http://127.0.0.1:${server.port}`;
    if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") && request.headers.get("origin") !== origin) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/health") return json({ ok: true, engine: "omp-native" });
    if (url.pathname.startsWith("/ui")) return uiFile(url.pathname);
    try {
      if (url.pathname === "/api/native/updates" && request.method === "GET") return json(updates.status());
      if (url.pathname === "/api/native/updates/check" && request.method === "POST") return json(await updates.check());
      if (url.pathname === "/api/native/updates/notified" && request.method === "POST") {
        const input = await body(request);
        if (typeof input.version !== "string") throw new Error("Update version required");
        await updates.markNotified(input.version);
        return json(updates.status());
      }
      if (url.pathname === "/api/native/sessions") {
        if (request.method === "GET") return json({ sessions: [...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
        if (request.method === "POST") return json({ session: await createSession(await body(request)) }, 201);
      }
      if (url.pathname === "/api/native/legacy" && request.method === "GET") return json({ tasks: await legacyList() });
      const terminalMatch = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/terminal(?:\/(start|input|resize|stop))?$/.exec(url.pathname);
      if (terminalMatch) {
        const [, id, action] = terminalMatch;
        const item = record(id);
        if (!action && request.method === "GET") return json({ active: terminals.has(id), output: terminals.get(id)?.output ?? "" });
        if (action === "start" && request.method === "POST") {
          if (terminals.has(id)) throw new Error("Native terminal is already open");
          const rpc = await host(id);
          const state = await rpc.command({ type: "get_state" });
          const data = "data" in state ? state.data as { isSettled?: boolean; hasPendingAsyncWork?: boolean } : null;
          if (!data?.isSettled || data.hasPendingAsyncWork) throw new Error("Wait for OMP to finish before opening its native terminal");
          const input = await body(request);
          const cols = Math.max(40, Math.min(240, Number(input.cols) || 100));
          const rows = Math.max(12, Math.min(100, Number(input.rows) || 30));
          const pty = new PtySession();
          const terminal = { pty, output: "" };
          terminals.set(id, terminal);
          await rpc.stop();
          processes.delete(id);
          const sessionDir = join(nativeRoot, "sessions", id);
          const env = Object.fromEntries(Object.entries({ ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir,
            ALPHA_COGNITION_FILE: join(nativeRoot, "cognition", `${id}.json`), ALPHA_NATIVE_SESSION_ID: id,
            ALPHA_DATA_ROOT: dataRoot }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
          const cli = join(appRoot, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
          const args = [cli, "--extension", join(appRoot, "src", "native", "tianshu-extension.ts"), "--extension", join(appRoot, "src", "native", "capabilities-extension.ts"), "--continue"];
          void pty.startArgv({ application: process.execPath, args, cwd: item.cwd, env, cols, rows }, (error, chunk) => {
            if (error) emit(id, { type: "terminal_error", error: error.message });
            if (chunk) { terminal.output = (terminal.output + chunk).slice(-100_000); emit(id, { type: "terminal_chunk", chunk }); }
          }).then(result => emit(id, { type: "terminal_exit", exitCode: result.exitCode })).catch(error => emit(id, { type: "terminal_error", error: String(error) })).finally(() => {
            terminals.delete(id);
            void host(id).catch(error => emit(id, { type: "host_error", error: String(error) }));
          });
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
      const match = /^\/api\/native\/sessions\/([0-9a-f-]{36})\/(state|messages|models|cognition|files|events|command|ui-response)$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        record(id);
        if (action === "cognition" && request.method === "GET") {
          const file = join(nativeRoot, "cognition", `${id}.json`);
          return json(await readFile(file, "utf8").then(text => JSON.parse(text), () => null));
        }
        if (action === "files" && request.method === "GET") {
          const directory = await readdir(record(id).cwd, { withFileTypes: true });
          const files = await Promise.all(directory.filter(item => !item.name.startsWith(".")).slice(0, 120).map(async item => ({
            name: item.name, type: item.isDirectory() ? "directory" : "file",
            size: item.isFile() ? await stat(join(record(id).cwd, item.name)).then(info => info.size, () => 0) : undefined,
          })));
          return json({ files });
        }
        if (action === "events" && request.method === "GET") {
          let currentController: ReadableStreamDefaultController<Uint8Array> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              currentController = controller;
              const clients = streams.get(id) ?? new Set();
              clients.add(controller);
              streams.set(id, clients);
              controller.enqueue(encoder.encode(": connected\n\n"));
              if (!terminals.has(id)) void host(id).catch(error => emit(id, { type: "host_error", error: String(error) }));
            },
            cancel() { if (currentController) streams.get(id)?.delete(currentController); },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
        }
        const process = await host(id);
        if (action === "state" && request.method === "GET") { const result = await process.command({ type: "get_state" }); return json("data" in result ? result.data : null); }
        if (action === "messages" && request.method === "GET") { const result = await process.command({ type: "get_messages" }); return json("data" in result ? result.data : null); }
        if (action === "models" && request.method === "GET") { const result = await process.command({ type: "get_available_models" }); return json("data" in result ? result.data : null); }
        if (action === "command" && request.method === "POST") {
          const input = await body(request);
          if (typeof input.type !== "string" || ["set_host_tools", "set_host_uri_schemes", "set_event_filter"].includes(input.type)) throw new Error("Unsupported desktop command");
          const response = await process.command(input as unknown as RpcCommand, ["compact", "login", "bash", "handoff"].includes(input.type) ? 300_000 : 30_000);
          const item = record(id);
          item.updatedAt = new Date().toISOString();
          void saveRecords();
          return json(response);
        }
        if (action === "ui-response" && request.method === "POST") {
          const input = await body(request);
          if (input.type !== "extension_ui_response" || typeof input.id !== "string") throw new Error("Invalid OMP UI response");
          process.sendFrame(input);
          return json({ accepted: true });
        }
      }
      return new Response("Not found", { status: 404 });
    } catch (error) { return errorResponse(error); }
  },
});

console.log(`ALPHA_SERVER_READY ${server.port}`);
process.on("SIGINT", () => {
  updates.stop();
  for (const terminal of terminals.values()) terminal.pty.kill();
  for (const pending of processes.values()) void pending.then(child => child.stop(), () => undefined);
  server.stop(true);
});
