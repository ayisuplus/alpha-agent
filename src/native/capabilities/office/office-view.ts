import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { OfficeError, officeRuntimeStatus } from "./office-runtime";

export interface OfficeViewPart { index: number; name: string; hidden?: boolean }
export interface OfficeViewInfo {
  id: string;
  kind: "text" | "spreadsheet" | "presentation";
  parts: OfficeViewPart[];
  part: number;
  width: number;
  height: number;
  readOnly: true;
  comments: Array<Record<string, unknown>>;
  revisions: Array<Record<string, unknown>>;
  pageRectangles?: string;
  notes?: Array<{ part: number; text: string }>;
}
export interface OfficeViewRenderOptions { part?: number; x?: number; y?: number; width?: number; height?: number; scale?: number }
export interface OfficeViewRender {
  image: string;
  mimeType: "image/png";
  part: number;
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
}
export interface OfficeViewSelectionOptions { part?: number; x: number; y: number; count?: 1 | 2 }
export interface OfficeViewSelection {
  selection: string;
  formula?: string;
  cellAddress?: string;
  part: number;
  width: number;
  height: number;
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface ViewProcess {
  id: string;
  directory: string;
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, Pending>;
  seq: number;
  queue: Promise<void>;
  exited: Promise<void>;
  stderr: string;
  closed: boolean;
  closing?: Promise<void>;
}

const views = new Map<string, ViewProcess>();
const closedError = () => new OfficeError("Office 原格式预览已关闭，请重新打开文档");
const fileExists = (path: string) => stat(path).then(item => item.isFile()).catch(() => false);

async function removePrivateDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith("alpha-office-view-")) {
    throw new OfficeError("拒绝清理非 Office 预览临时目录");
  }
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

function rejectPending(view: ViewProcess, error: Error): void {
  for (const pending of view.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  view.pending.clear();
}

async function dispose(view: ViewProcess): Promise<void> {
  if (view.closing) return view.closing;
  view.closed = true;
  views.delete(view.id);
  rejectPending(view, closedError());
  view.closing = (async () => {
    view.child.stdin.end();
    await Promise.race([view.exited, Bun.sleep(1500)]);
    if (view.child.exitCode === null && view.child.signalCode === null && view.child.pid) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(view.child.pid)], { windowsHide: true, stdio: "ignore" });
        await new Promise<void>(resolveDone => { killer.once("exit", () => resolveDone()); killer.once("error", () => resolveDone()); });
      } else view.child.kill("SIGKILL");
      await Promise.race([view.exited, Bun.sleep(1500)]);
    }
    await removePrivateDirectory(view.directory);
  })();
  return view.closing;
}

function receive(view: ViewProcess, line: string): void {
  let response: { seq?: number; ok?: boolean; result?: unknown; error?: string };
  try { response = JSON.parse(line) as typeof response; } catch { return; }
  if (typeof response.seq !== "number") return;
  const pending = view.pending.get(response.seq);
  if (!pending) return;
  view.pending.delete(response.seq);
  clearTimeout(pending.timer);
  if (response.ok) pending.resolve(response.result);
  else pending.reject(new OfficeError(response.error || "Office 原格式预览失败"));
}

async function request<T>(view: ViewProcess, action: string, options?: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (view.closed) throw closedError();
  const seq = action === "open" ? 0 : ++view.seq;
  const abort = () => {
    rejectPending(view, signal?.reason instanceof Error ? signal.reason : new OfficeError("Office 预览已取消"));
    void dispose(view).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        view.pending.delete(seq);
        reject(new OfficeError("Office 原格式预览超时，文档引擎已关闭；请在原应用中打开"));
        void dispose(view).catch(() => undefined);
      }, 30_000);
      view.pending.set(seq, { resolve: value => resolveResult(value as T), reject, timer });
      if (action !== "open") view.child.stdin.write(`${JSON.stringify({ seq, action, options })}\n`);
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function command<T>(id: string, action: string, options?: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const view = views.get(id);
  if (!view || view.closed) throw closedError();
  const result = view.queue.then(() => request<T>(view, action, options, signal));
  view.queue = result.then(() => undefined, () => undefined);
  return result;
}

/** Coordinates and document dimensions are TWIPs; 15 TWIPs are one CSS px at scale 1. */
export async function openOfficeView(path: string, signal?: AbortSignal): Promise<OfficeViewInfo> {
  signal?.throwIfAborted();
  if (process.platform !== "win32") throw new OfficeError("当前原格式 Office 预览仅验证了 Windows LibreOffice 运行时");
  const extension = extname(path).toLowerCase();
  if (![".docx", ".odt", ".rtf", ".xlsx", ".ods", ".pptx", ".odp"].includes(extension)) {
    throw new OfficeError("不支持此文件的 Office 原格式预览");
  }
  if (extension === ".odt" || extension === ".rtf") {
    throw new OfficeError("当前 Windows LibreOffice 的 ODT/RTF 原格式视图尚未通过验证，请在原应用中打开；可另行选择静态预览");
  }
  const status = await officeRuntimeStatus();
  if (!status.available) throw new OfficeError("本机缺少 LibreOffice，无法加载 Office 原格式视图");
  const root = status.location === "bundled"
    ? join(resolve(import.meta.dir, "..", "..", "..", ".."), "runtime", "libreoffice")
    : join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice");
  const program = join(root, "program");
  if (!(await fileExists(join(program, "mergedlo.dll")))) throw new OfficeError("LibreOffice 缺少 LibreOfficeKit 原格式视图运行时");
  const config = await readFile(join(program, "pythonloader.uno.ini"), "utf8").catch(() => "");
  const core = config.match(/^PYUNO_LOADER_PYTHONHOME=\$ORIGIN\/(python-core-[\d.]+)\r?$/m)?.[1];
  if (!core) throw new OfficeError("LibreOffice 缺少已验证的 Python 运行时配置");
  const pythonHome = join(program, core);
  const python = join(pythonHome, "bin", "python.exe");
  if (!(await fileExists(python))) throw new OfficeError("LibreOffice 缺少原格式视图 Python 解释器");
  const directory = await mkdtemp(join(tmpdir(), "alpha-office-view-"));
  let view: ViewProcess | undefined;
  try {
    const input = join(directory, basename(path));
    await copyFile(path, input, constants.COPYFILE_EXCL);
    signal?.throwIfAborted();
    // Start the interpreter directly so cancellation owns its entire native process tree.
    const child = spawn(python, ["-B", "-u", join(import.meta.dir, "office-view-worker.py"),
      "--program", program, "--input", input, "--profile", join(directory, "profile")],
    { windowsHide: true, env: { ...process.env, PATH: `${program};${process.env.PATH ?? ""}`,
      PYTHONHOME: pythonHome, PYTHONPATH: [program, join(pythonHome, "lib"), join(pythonHome, "lib", "site-packages")].join(";"),
      URE_BOOTSTRAP: `vnd.sun.star.pathname:${join(program, "fundamental.ini")}`,
      PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }, stdio: "pipe" });
    let exitedResolve!: () => void;
    view = { id: randomUUID(), directory, child, pending: new Map(), seq: 0, queue: Promise.resolve(),
      exited: new Promise<void>(resolveDone => { exitedResolve = resolveDone; }), stderr: "", closed: false };
    const current = view;
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        receive(current, stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
      }
    });
    child.stderr.on("data", (chunk: string) => { current.stderr = `${current.stderr}${chunk}`.slice(-2000); });
    child.stdin.on("error", error => { rejectPending(current, new OfficeError(`Office 预览进程通信失败：${error.message}`)); });
    child.once("error", error => {
      rejectPending(current, new OfficeError(`Office 预览进程启动失败：${error.message}`));
      exitedResolve();
      void dispose(current).catch(() => undefined);
    });
    child.once("exit", (code, signalName) => {
      rejectPending(current, new OfficeError(`Office 原格式视图进程退出（${code ?? signalName ?? "未知"}）：${current.stderr.trim()}`));
      exitedResolve();
      void dispose(current).catch(() => undefined);
    });
    views.set(view.id, view);
    const result = await request<Omit<OfficeViewInfo, "id">>(view, "open", undefined, signal);
    return { id: view.id, ...result };
  } catch (error) {
    if (view) await dispose(view); else await removePrivateDirectory(directory);
    throw error;
  }
}

function coordinate(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 0x7fff_ffff);
}

export async function renderOfficeView(id: string, options: OfficeViewRenderOptions = {}, signal?: AbortSignal): Promise<OfficeViewRender> {
  if (!coordinate(options.x) || !coordinate(options.y) || !coordinate(options.part)) throw new OfficeError("Office 预览坐标或页编号无效");
  for (const size of [options.width, options.height]) {
    if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 2048)) throw new OfficeError("Office 预览像素尺寸须为 1–2048");
  }
  if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale < 0.25 || options.scale > 4)) throw new OfficeError("Office 预览缩放须为 0.25–4");
  return command(id, "render", options, signal);
}

export async function selectOfficeView(id: string, options: OfficeViewSelectionOptions, signal?: AbortSignal): Promise<OfficeViewSelection> {
  if (!coordinate(options.x) || !coordinate(options.y) || !coordinate(options.part)
    || options.x === undefined || options.y === undefined || (options.count !== undefined && options.count !== 1 && options.count !== 2)) {
    throw new OfficeError("Office 预览选择坐标无效");
  }
  return command(id, "select", options, signal);
}

export async function getOfficeView(id: string): Promise<OfficeViewInfo> {
  const info = await command<Omit<OfficeViewInfo, "id">>(id, "info");
  return { id, ...info };
}

export async function closeOfficeView(id: string): Promise<void> {
  const view = views.get(id);
  if (view) await dispose(view);
}
export function isOfficeViewOpen(id: string): boolean {
  const view = views.get(id);
  return Boolean(view && !view.closed && view.child.exitCode === null && view.child.signalCode === null);
}
