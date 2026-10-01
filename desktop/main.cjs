const { app, BaseWindow, dialog, ipcMain, Menu, Notification, screen, shell: electronShell, WebContentsView } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { connect, createServer } = require("node:net");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
// Per-run token for the local sidecar API; the renderer receives it only through the preload bridge.
// Scripts may pin it via ALPHA_SERVER_TOKEN (dev/automation); otherwise it is random per run.
const serverToken = process.env.ALPHA_SERVER_TOKEN || require("node:crypto").randomBytes(32).toString("hex");
const workspaceRoot = path.resolve(process.env.ALPHA_WORKSPACE_ROOT || root);
const desktopState = require("./state-storage.cjs").stateStorage(workspaceRoot);
const userData = path.join(workspaceRoot, ".alpha", "electron-profile");
mkdirSync(userData, { recursive: true });
app.setName("Alpha");
app.setPath("userData", userData);
const primary = app.requestSingleInstanceLock();

let sidecar;
let sidecarPort = null;
let hostCdpPort = null;
let window;
let shell;
const workbenchWindows = new Map();
const deliveredNotices = new Map();
let browserTakeoverOwner = null;
function publish(channel, payload) {
  for (const item of workbenchWindows.values()) if (!item.shell.webContents.isDestroyed()) item.shell.webContents.send(channel, payload);
}

// ── Alpha 浏览器宿主（独立 Electron 进程，见 desktop/browser-host.cjs）─────────────────────────
// 宿主只在 127.0.0.1 随机端口开放 CDP，供 OMP 原生 browser 工具（browser.cdpUrl）与下方的只读面板使用；
// 桌面窗口本身不开任何调试端口、没有 HTTP 桥，也不出现在任何 CDP 目标中。
let host;
let hostCdpUrl = null; // http://127.0.0.1:<port>
let hostControl = null; // 宿主控制连接（127.0.0.1，逐行 JSON；断开即宿主退出）
let hostStatus = { available: false, port: null, reason: "浏览器宿主未启动" };
const screencasts = new Map(); // targetId → { socket, nextId, pending: Map<number, Function> }

/** 打包形态用发行包自带的 Electron（<bundle>/node_modules/electron/dist）；开发态同一路径即仓库内 Electron。 */
function electronExecutable() {
  const bundled = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  try { realpathSync(bundled); return bundled; } catch { return process.execPath; }
}

function publishHostStatus(reason) {
  hostStatus = hostCdpUrl
    ? { available: true, port: Number(new URL(hostCdpUrl).port) }
    : { available: false, port: null, reason: reason ?? hostStatus.reason };
  publish("alpha:browser-host-status-changed", hostStatus);
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startBrowserHost() {
  // CDP 端口在整个工作台生命周期内保持稳定：重启宿主后 OMP 侧已生成的 browser.cdpUrl 依然有效。
  hostCdpPort ??= await pickFreePort();
  return new Promise(resolve => {
    const child = spawn(electronExecutable(), [path.join(__dirname, "browser-host.cjs"), "--cdp-port", String(hostCdpPort)], {
      cwd: root,
      env: { ...process.env, ALPHA_WORKSPACE_ROOT: workspaceRoot },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    host = child;
    let buffer = "";
    let settled = false;
    const finish = url => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(url);
    };
    const timeout = setTimeout(() => finish(null), 30_000);
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const match = /^ALPHA_BROWSER_HOST_READY (\d+) (\d+)$/.exec(line);
        if (match) {
          hostCdpUrl = `http://127.0.0.1:${match[1]}`;
          hostControl = connect({ host: "127.0.0.1", port: Number(match[2]) });
          hostControl.on("error", () => {});
          hostControl.once("connect", () => {
            publishHostStatus();
            finish(hostCdpUrl);
          });
        } else if (line) console.log(line);
      }
    });
    child.stderr.on("data", chunk => console.error(chunk.toString()));
    child.once("error", () => finish(null));
    child.once("exit", () => {
      // 只有当前宿主退出才清状态：重启流程里旧进程的退出不覆盖新宿主。
      if (host !== child) return;
      hostCdpUrl = null;
      for (const targetId of [...screencasts.keys()]) stopScreencast(targetId);
      publishHostStatus("浏览器宿主已退出");
      finish(null);
    });
  });
}

async function cdpPageEntries() {
  if (!hostCdpUrl) throw new Error("浏览器宿主不可用");
  const response = await fetch(`${hostCdpUrl}/json/list`);
  if (!response.ok) throw new Error(`浏览器宿主 CDP 查询失败：HTTP ${response.status}`);
  const targets = await response.json();
  return targets
    .filter(target => target.type === "page" && typeof target.webSocketDebuggerUrl === "string" && !String(target.url).startsWith("devtools://"))
    .map(target => ({ targetId: target.id, url: String(target.url ?? ""), title: String(target.title ?? ""), webSocketDebuggerUrl: target.webSocketDebuggerUrl }));
}

function pushScreencastFrame(targetId, params) {
  const frame = {
    targetId,
    format: "jpeg",
    data: params.data,
    metadata: {
      offsetTop: params.offsetTop,
      pageScaleFactor: params.pageScaleFactor,
      deviceWidth: params.deviceWidth,
      deviceHeight: params.deviceHeight,
      scrollOffsetX: params.scrollOffsetX,
      scrollOffsetY: params.scrollOffsetY,
      timestamp: params.timestamp,
    },
  };
  for (const id of screencasts.get(targetId)?.owners ?? []) workbenchWindows.get(id)?.shell.webContents.send("alpha:browser-screencast-frame", frame);
}

async function startScreencast(targetId, maxDimension, owner) {
  if (screencasts.has(targetId)) { screencasts.get(targetId).owners.add(owner); return; }
  const entry = (await cdpPageEntries()).find(item => item.targetId === targetId);
  if (!entry) throw new Error("浏览器宿主中没有这个页面目标");
  const socket = new WebSocket(entry.webSocketDebuggerUrl);
  const stream = { socket, nextId: 0, pending: new Map(), owners: new Set([owner]) };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++stream.nextId;
    stream.pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = message => {
    const frame = JSON.parse(message.data);
    if (frame.id && stream.pending.has(frame.id)) {
      const pending = stream.pending.get(frame.id);
      stream.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error.message));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method === "Page.screencastFrame") {
      pushScreencastFrame(targetId, frame.params ?? {});
      void call("Page.screencastFrameAck", { sessionId: frame.params?.sessionId }).catch(() => {});
    }
  };
  socket.onclose = () => {
    screencasts.delete(targetId);
    for (const id of stream.owners) workbenchWindows.get(id)?.shell.webContents.send("alpha:browser-screencast-frame", { targetId, format: "jpeg", data: null, error: "页面截屏流已结束" });
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("无法连接浏览器宿主的页面目标"));
  });
  screencasts.set(targetId, stream);
  try {
    await call("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: maxDimension, maxHeight: maxDimension });
    // 隐身（屏幕外）的宿主窗口没有自发的合成帧，截屏流冷启动可能不出首帧：强制一帧唤醒（结果丢弃）。
    await call("Page.captureScreenshot", { format: "jpeg" }).catch(() => {});
  } catch (error) {
    screencasts.delete(targetId);
    socket.close();
    throw error;
  }
}

function stopScreencast(targetId, owner) {
  const stream = screencasts.get(targetId);
  if (!stream) return;
  if (owner !== undefined) { stream.owners.delete(owner); if (stream.owners.size) return; }
  screencasts.delete(targetId);
  stream.socket.send(JSON.stringify({ id: ++stream.nextId, method: "Page.stopScreencast" }));
  stream.socket.close();
}

function sendHostCommand(message) {
  if (!hostControl || hostControl.destroyed || !hostControl.writable) return false;
  hostControl.write(`${JSON.stringify(message)}\n`);
  return true;
}

/** 面板矩形（工作台 CSS 像素）→ 屏幕坐标，交给宿主窗口做“接管”。 */
function panelScreenRect(value, owner = { window, shell }) {
  const { window, shell } = owner;
  if (!window || !shell || !value || typeof value !== "object") return null;
  const numbers = ["x", "y", "width", "height"].map(key => Number(value[key]));
  if (!numbers.every(Number.isFinite)) return null;
  const [x, y, width, height] = numbers;
  if (width < 120 || height < 80) return null;
  const zoom = shell.webContents.getZoomFactor();
  const content = window.getContentBounds();
  return {
    x: Math.round(content.x + x * zoom),
    y: Math.round(content.y + y * zoom),
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
  };
}
// ────────────────────────────────────────────────────────────────────────────────────────────────

function startSidecar() {
  return new Promise((resolve, reject) => {
    const executable = process.env.ALPHA_BUN_PATH || "bun";
    sidecar = spawn(executable, ["run", "src/native/server.ts"], {
      cwd: root,
      env: { ...process.env, ALPHA_ELECTRON_VERSION: process.versions.electron, ALPHA_SERVER_TOKEN: serverToken, ALPHA_DESKTOP_PID: String(process.pid), ALPHA_DESKTOP_EXECUTABLE: process.execPath, ALPHA_DESKTOP_ARGS: JSON.stringify(app.isPackaged ? [] : [path.join(root, "desktop", "main.cjs")]), ...(hostCdpUrl ? { ALPHA_BROWSER_CDP_URL: hostCdpUrl } : {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let errorTail = "";
    const timeout = setTimeout(() => { sidecar.kill(); reject(new Error(`Alpha sidecar did not start\n${errorTail}`)); }, 60_000);
    sidecar.stdout.on("data", chunk => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const match = /^ALPHA_SERVER_READY (\d+)$/.exec(line);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
        console.log(line);
      }
    });
    sidecar.stderr.on("data", chunk => { errorTail = (errorTail + chunk.toString()).slice(-2_000); console.error(chunk.toString()); });
    sidecar.once("error", error => { clearTimeout(timeout); reject(error); });
    sidecar.once("exit", code => { clearTimeout(timeout); if (!window) reject(new Error(`Alpha sidecar exited: ${code}\n${errorTail}`)); });
  });
}

const windowStateFile = path.join(workspaceRoot, ".alpha", "window-state.json");

/** Restores the last window size and position, but only if it is still mostly on a connected display. */
function savedWindowState() {
  try {
    const state = JSON.parse(readFileSync(windowStateFile, "utf8"));
    const { x, y, width, height } = state;
    if (![x, y, width, height].every(Number.isFinite) || width < 1080 || height < 620) return null;
    const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
    const visibleWidth = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const visibleHeight = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    if (visibleWidth < 200 || visibleHeight < 120) return null;
    return { x, y, width, height, maximized: state.maximized === true };
  } catch { return null; }
}

function saveWindowState(target = window) {
  if (!target) return;
  try {
    writeFileSync(windowStateFile, JSON.stringify({ ...target.getNormalBounds(), maximized: target.isMaximized() }));
  } catch (error) { console.error("ALPHA_WINDOW_STATE_FAILED", error); }
}

// 打开/揭示文件的边界：工作区树 + 所有会话项目目录（产物按约定写在会话项目里）。
// 会话目录以 sidecar 为权威来源，短缓存避免每次点击都问。
let boundaryRootsCache = null;
let boundaryRootsAt = 0;
async function workspaceBoundaryRoots() {
  if (boundaryRootsCache && Date.now() - boundaryRootsAt < 10_000) return boundaryRootsCache;
  const roots = [workspaceRoot];
  try {
    const response = await fetch(`http://127.0.0.1:${sidecarPort}/api/native/sessions`, { headers: { "x-alpha-token": serverToken } });
    const data = await response.json();
    for (const session of data.sessions ?? []) if (session && typeof session.cwd === "string") roots.push(session.cwd);
  } catch { /* sidecar 不可达时退回工作区根 */ }
  boundaryRootsCache = roots.map(root => { try { return realpathSync(root); } catch { return root; } });
  boundaryRootsAt = Date.now();
  return boundaryRootsCache;
}

async function insideWorkspaceBoundary(target) {
  for (const root of await workspaceBoundaryRoots()) {
    if (target === root) return true;
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return true;
  }
  return false;
}

// 产物按约定写在会话项目内，工具返回的是项目相对路径；相对路径依次用工作区/会话项目根解析。
async function resolveUserPath(targetPath) {
  try { return realpathSync(targetPath); } catch { /* 相对路径继续按根解析 */ }
  for (const root of await workspaceBoundaryRoots()) {
    try {
      const joined = realpathSync(path.resolve(root, targetPath));
      if (joined === root || joined.startsWith(root + path.sep)) return joined;
    } catch { /* 该根下不存在，试下一个 */ }
  }
  return null;
}

function installMenu() {
  const commands = require("./commands.json");
  let preferences = {};
  try { preferences = JSON.parse(desktopState.getItem("alpha-ui-preferences") || "{}"); } catch {}
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Alpha", submenu: commands.map(command => {
      const key = preferences.shortcuts?.[command.id];
      const valid = typeof key === "string" && (key === "" || /^(Ctrl\+)?(Shift\+)?(Alt\+)?(?:[A-Z0-9,./;\[\]\\]|F(?:[1-9]|1[0-2]))$/.test(key) && /Ctrl\+|Alt\+/.test(key));
      return { label: preferences.language === "en" ? command.en : command.description, accelerator: (valid ? key : command.key)?.replace("Ctrl", "CmdOrCtrl") || undefined, registerAccelerator: false, click: () => shell?.webContents.send("alpha:command", command.id) };
    }) },
    { role: "editMenu", label: preferences.language === "en" ? "Edit" : "编辑" },
    { label: preferences.language === "en" ? "Developer" : "开发", submenu: [
      { label: preferences.language === "en" ? "Reload workbench" : "重新载入工作台", accelerator: "CmdOrCtrl+R", click: () => shell?.webContents.reload() },
      { label: preferences.language === "en" ? "Developer tools" : "工作台开发者工具", accelerator: "CmdOrCtrl+Shift+I", click: () => shell?.webContents.toggleDevTools() },
    ] },
  ]));
}

async function createDesktopWindow(port, restore = false) {
  const saved = restore ? savedWindowState() : null;
  const nextWindow = new BaseWindow({ width: 1460, height: 900, ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}), minWidth: 1080, minHeight: 620, title: "Alpha", backgroundColor: "#f8fafc", autoHideMenuBar: true });
  const nextShell = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  nextWindow.contentView.addChildView(nextShell);
  workbenchWindows.set(nextShell.webContents.id, { window: nextWindow, shell: nextShell });
  window = nextWindow; shell = nextShell;
  if (saved?.maximized) nextWindow.maximize();
  let saveTimer;
  const layout = () => { const { width, height } = nextWindow.getContentBounds(); nextShell.setBounds({ x: 0, y: 0, width, height }); };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) nextWindow.on(event, () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveWindowState(nextWindow), 600); });
  nextWindow.on("close", () => { clearTimeout(saveTimer); saveWindowState(nextWindow); });
  nextWindow.on("focus", () => { window = nextWindow; shell = nextShell; nextWindow.flashFrame(false); });
  nextWindow.on("resize", layout); layout();
  nextWindow.on("closed", () => {
    const id = nextShell.webContents.id;
    workbenchWindows.delete(id);
    for (const targetId of [...screencasts.keys()]) stopScreencast(targetId, id);
    if (browserTakeoverOwner === id) { sendHostCommand({ op: "hide" }); browserTakeoverOwner = null; }
    nextShell.webContents.close();
    if (window === nextWindow) { const remaining = [...workbenchWindows.values()].at(-1); window = remaining?.window; shell = remaining?.shell; }
  });
  nextShell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void nextShell.webContents.setVisualZoomLevelLimits(1, 1);
  await nextShell.webContents.loadURL(`http://127.0.0.1:${port}/ui/`);
  return { windowId: nextWindow.id };
}

if (!primary) {
  console.log("ALPHA_ALREADY_RUNNING");
  app.quit();
} else {
app.on("second-instance", () => window?.focus());
app.whenReady().then(async () => {
  try {
    app.setAppUserModelId("Alpha");
    // 浏览器宿主先行：拿到 CDP 端口后经 ALPHA_BROWSER_CDP_URL 传给 sidecar（由 launch.ts 写入
    // 生成配置的 browser.cdpUrl；不会进入模型进程环境）。宿主不可用时照常启动，浏览器面板提示
    // “当前为不可见模式”，OMP 回退自己的默认浏览器。
    await startBrowserHost();
    const port = await startSidecar();
    sidecarPort = port;
    installMenu();
    ipcMain.handle("alpha:new-window", event => { if (!workbenchWindows.has(event.sender.id)) throw new Error("Unauthorized window"); return createDesktopWindow(sidecarPort); });
    let updateInstalling = false;
    ipcMain.handle("alpha:install-update", async (event, id) => {
      if (!workbenchWindows.has(event.sender.id) || updateInstalling) throw new Error("Update handoff is unavailable");
      updateInstalling = true;
      try {
        const response = await fetch(`http://127.0.0.1:${sidecarPort}/api/native/app-updates`, { method: "POST", headers: { "content-type": "application/json", "x-alpha-token": serverToken }, body: JSON.stringify({ action: "install", id }) });
        if (!response.ok) throw new Error((await response.json()).error || "Update preparation failed");
        const helper = await response.json();
        const child = spawn(helper.executable, helper.args, { detached: true, windowsHide: true, stdio: "ignore", env: process.env });
        await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
        for (const owned of [sidecar, host]) {
          if (!owned?.pid || owned.exitCode !== null || owned.signalCode !== null) continue;
          if (process.platform === "win32") await new Promise(resolve => { const stop = spawn("taskkill.exe", ["/T", "/F", "/PID", String(owned.pid)], { windowsHide: true, stdio: "ignore" }); stop.once("close", resolve); stop.once("error", resolve); });
          else owned.kill();
        }
        sidecar = null; host = null;
        setImmediate(() => app.quit()); return true;
      } catch (error) { updateInstalling = false; throw error; }
    });
    ipcMain.handle("alpha:choose-paths", async (event, kind) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner || !["directory", "files"].includes(kind)) return [];
      const result = await dialog.showOpenDialog(window, { properties: kind === "directory" ? ["openDirectory"] : ["openFile", "multiSelections"] });
      return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle("alpha:open-folder", async (event, targetPath) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner || typeof targetPath !== "string") return "不允许打开这个路径";
      try {
        const target = await resolveUserPath(targetPath);
        if (!target || !(await insideWorkspaceBoundary(target))) return "路径不在 Alpha 工作区或会话项目内";
        return await electronShell.openPath(target);
      } catch { return "路径不存在"; }
    });
    ipcMain.handle("alpha:reveal-item", async (event, targetPath) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner || typeof targetPath !== "string") return "不允许打开这个路径";
      try {
        const target = await resolveUserPath(targetPath);
        if (!target || !(await insideWorkspaceBoundary(target))) return "路径不在 Alpha 工作区或会话项目内";
        electronShell.showItemInFolder(target);
        return "";
      } catch { return "路径不存在"; }
    });
    let hostRestarting = false;
    ipcMain.handle("alpha:browser-host-restart", async event => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner) return { ok: false, reason: "未授权的调用方" };
      if (hostRestarting) return { ok: false, reason: "浏览器宿主正在重启，请稍候" };
      hostRestarting = true;
      browserTakeoverOwner = null;
      try {
        try { hostControl?.destroy(); } catch { /* 旧控制连接随宿主一起结束 */ }
        host?.kill();
        for (const targetId of [...screencasts.keys()]) stopScreencast(targetId);
        const url = await startBrowserHost();
        return url ? { ok: true } : { ok: false, reason: "浏览器宿主未能启动" };
      } catch (error) {
        return { ok: false, reason: String(error) };
      } finally {
        hostRestarting = false;
      }
    });
    ipcMain.handle("alpha:open-external", async (event, value) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner || typeof value !== "string") return false;
      let url;
      try { url = new URL(value); } catch { return false; }
      const localDevServer = url.protocol === "http:" && url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !localDevServer) return false;
      await electronShell.openExternal(value);
      return true;
    });
    ipcMain.handle("alpha:open-editor", async (event, targetPath) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner || typeof targetPath !== "string" || !path.isAbsolute(targetPath)) return "Invalid editor path";
      try { realpathSync(targetPath); } catch { return "File is unavailable"; }
      let preferences = {};
      try { preferences = JSON.parse(desktopState.getItem("alpha-ui-preferences") || "{}"); } catch {}
      const executable = preferences.editor || process.env.VISUAL || process.env.EDITOR || "notepad.exe";
      if (preferences.editor && !path.isAbsolute(preferences.editor)) return "External editor must be an absolute executable path";
      return new Promise(resolve => {
        const editor = spawn(executable, [targetPath], { windowsHide: false });
        editor.once("spawn", () => resolve("")); editor.once("error", error => resolve(error.message));
      });
    });
    ipcMain.handle("alpha:save-text", async (event, filename, content) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner || typeof filename !== "string" || typeof content !== "string") return false;
      if (Buffer.byteLength(content) > 100_000_000) throw new Error("Export exceeds 100 MB; save from the native session terminal");
      const safeName = filename.replace(/[<>:"/\\|?*]/g, "_").slice(0, 100) || "alpha-report.md";
      const extension = path.extname(safeName).slice(1) || "md";
      const choice = await dialog.showSaveDialog(window, { defaultPath: safeName, filters: [{ name: extension === "html" ? "HTML" : "Markdown", extensions: [extension] }] });
      if (choice.canceled || !choice.filePath) return false;
      writeFileSync(choice.filePath, content, "utf8");
      return true;
    });
    ipcMain.on("alpha:notify", (event, title, body, taskId) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      let preferences = {};
      try { preferences = JSON.parse(desktopState.getItem("alpha-ui-preferences") || "{}"); } catch {}
      if (!owner || preferences.notifications === false || [...workbenchWindows.values()].some(item => item.window.isFocused()) || !Notification.isSupported() ||
          typeof title !== "string" || typeof body !== "string" || (taskId !== "omp-update" && !/^[0-9a-f-]{36}$/.test(taskId))) return;
      const key = taskId + ":" + title + ":" + body;
      const now = Date.now();
      for (const [id, at] of deliveredNotices) if (now - at > 15_000) deliveredNotices.delete(id);
      if (deliveredNotices.has(key)) return;
      deliveredNotices.set(key, now);
      const notice = new Notification({ title: title.slice(0, 100), body: body.slice(0, 250), silent: preferences.sound !== true });
      notice.on("click", () => { const target = workbenchWindows.get(event.sender.id) ?? [...workbenchWindows.values()][0]; if (target) { target.window.show(); target.window.focus(); target.shell.webContents.send("alpha:open-task", taskId); } });
      notice.show();
    });
    ipcMain.on("alpha:attention", event => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (owner && !window.isFocused()) window.flashFrame(true);
    });
    // ── 浏览器面板 IPC（契约详见 desktop/preload.cjs 顶部注释）────────────────────────────────────
    ipcMain.on("alpha:storage", (event, operation, key, value) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner || !["getItem", "setItem", "removeItem"].includes(operation)) { event.returnValue = { error: "Invalid desktop storage request" }; return; }
      try { event.returnValue = { value: desktopState[operation](key, value) }; if (operation !== "getItem" && key === "alpha-ui-preferences") installMenu(); if (operation !== "getItem") for (const item of workbenchWindows.values()) if (item !== owner) item.shell.webContents.send("alpha:storage-changed", { key, value: operation === "removeItem" ? null : value }); }
      catch (error) { event.returnValue = { error: error.message }; }
    });
    ipcMain.handle("alpha:server-token", event => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner) return null;
      return serverToken;
    });
    ipcMain.handle("alpha:browser-host-status", event => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner) return { available: false, port: null, reason: "未授权的调用方" };
      return hostStatus;
    });
    ipcMain.handle("alpha:browser-tabs", async event => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner) return { available: false, tabs: [], error: "未授权的调用方" };
      try {
        const entries = await cdpPageEntries();
        return { available: true, tabs: entries.map(({ targetId, url, title }) => ({ targetId, url, title })) };
      } catch (error) {
        return { available: false, tabs: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle("alpha:browser-screencast", async (event, request) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner) return { ok: false, error: "未授权的调用方" };
      const targetId = request?.targetId;
      const action = request?.action;
      if (typeof targetId !== "string" || !targetId || (action !== "start" && action !== "stop")) return { ok: false, error: "参数不合法" };
      try {
        const maxDimension = Math.min(Math.max(Math.round(Number(request.maxDimension)) || 1280, 160), 2560);
        if (action === "start") await startScreencast(targetId, maxDimension, event.sender.id);
        else stopScreencast(targetId, event.sender.id);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle("alpha:browser-takeover", (event, request) => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner) return { ok: false, error: "未授权的调用方" };
      if (browserTakeoverOwner !== null && browserTakeoverOwner !== event.sender.id) return { ok: false, error: "浏览器正由另一个窗口接管，请先交还" };
      const rect = panelScreenRect(request?.rect, owner);
      if (!rect) return { ok: false, error: "面板矩形不合法" };
      const targetId = typeof request?.targetId === "string" && request.targetId ? request.targetId : undefined;
      if (!sendHostCommand({ op: "show", ...rect, targetId })) return { ok: false, error: "浏览器宿主不可用" };
      browserTakeoverOwner = event.sender.id;
      return { ok: true };
    });
    ipcMain.handle("alpha:browser-handback", event => {
      const owner = workbenchWindows.get(event.sender.id); const window = owner?.window; const shell = owner?.shell;
      if (!owner) return { ok: false, error: "未授权的调用方" };
      if (browserTakeoverOwner !== null && browserTakeoverOwner !== event.sender.id) return { ok: false, error: "浏览器由另一个窗口接管" };
      browserTakeoverOwner = null;
      return sendHostCommand({ op: "hide" }) ? { ok: true } : { ok: false, error: "浏览器宿主不可用" };
    });
    // ────────────────────────────────────────────────────────────────────────────────────────────
    await createDesktopWindow(port, true);
    if (process.env.ALPHA_UPDATE_READY_FILE && process.env.ALPHA_UPDATE_READY_TOKEN && process.env.ALPHA_UPDATE_TRANSACTION_ID) {
      const readyPath = path.resolve(process.env.ALPHA_UPDATE_READY_FILE), readyRoot = path.join(workspaceRoot, ".alpha", "updates") + path.sep;
      if (!readyPath.startsWith(readyRoot)) throw new Error("Update readiness file is outside Alpha data");
      let ready = false;
      for (let count = 0; count < 100 && !ready; count++) { ready = await shell.webContents.executeJavaScript("!!document.querySelector('.native-workbench')"); if (!ready) await new Promise(resolve => setTimeout(resolve, 100)); }
      if (!ready) throw new Error("Updated workbench did not render");
      writeFileSync(readyPath, JSON.stringify({ id: process.env.ALPHA_UPDATE_TRANSACTION_ID, token: process.env.ALPHA_UPDATE_READY_TOKEN, version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, pid: process.pid, port: sidecarPort }));
      delete process.env.ALPHA_UPDATE_READY_FILE; delete process.env.ALPHA_UPDATE_READY_TOKEN; delete process.env.ALPHA_UPDATE_TRANSACTION_ID;
    }
    console.log(`ALPHA_DESKTOP_READY ${port}`);
  } catch (error) {
    console.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    const workspace = /Alpha local workspace is not writable: ([^\r\n]+?)(?=: E[A-Z]+:|$)/m.exec(detail)?.[1];
    dialog.showErrorBox("Alpha 无法启动", workspace
      ? `本地工作目录不可用：\n${workspace}\n\n请确认该目录存在且可写，然后重新启动 Alpha。`
      : detail.split(/\r?\n/).slice(0, 2).join("\n"));
    app.quit();
  }
});
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  sendHostCommand({ op: "quit" });
  for (const child of [sidecar, host]) {
    if (!child?.pid) continue;
    if (process.platform === "win32") spawn("taskkill.exe", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" }).unref();
    else child.kill();
  }
});
