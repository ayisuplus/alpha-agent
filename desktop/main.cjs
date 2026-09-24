const { app, BaseWindow, dialog, ipcMain, Menu, Notification, screen, shell: electronShell, WebContentsView } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(process.env.ALPHA_WORKSPACE_ROOT || root);
const userData = path.join(workspaceRoot, ".alpha", "electron-profile");
mkdirSync(userData, { recursive: true });
app.setName("Alpha");
app.setPath("userData", userData);
const primary = app.requestSingleInstanceLock();
const cdpPort = process.env.ALPHA_CDP_PORT;
if (!cdpPort) throw new Error("ALPHA_CDP_PORT is required");
app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
// Browser verification takes screenshots of the preview; without this, Windows occlusion tracking stops painting the
// window whenever other windows cover it and the verifier's screenshot times out. (A minimized window still pauses.)
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let sidecar;
let window;
let shell;
let preview;
const emptyPreview = "data:text/html," + encodeURIComponent("<title>Alpha preview</title><style>body{font-family:system-ui;background:#f6f7f9;color:#4d5968;display:grid;place-items:center;height:100vh;margin:0}</style><p>选择任务后，产品预览将在这里打开</p>");

function startSidecar() {
  return new Promise((resolve, reject) => {
    const executable = process.env.ALPHA_BUN_PATH || "bun";
    sidecar = spawn(executable, ["run", "src/server.ts"], { cwd: root, env: { ...process.env, ALPHA_ELECTRON_VERSION: process.versions.electron }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let errorTail = "";
    const timeout = setTimeout(() => { sidecar.kill(); reject(new Error(`Alpha sidecar did not start\n${errorTail}`)); }, 20_000);
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

function previewBounds(value) {
  if (!value || typeof value !== "object") return null;
  const numbers = ["x", "y", "width", "height"].map(key => value[key]);
  if (!numbers.every(item => typeof item === "number" && Number.isFinite(item))) return null;
  return { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3], visible: value.visible === true };
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

function saveWindowState() {
  if (!window) return;
  try {
    writeFileSync(windowStateFile, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
  } catch (error) { console.error("ALPHA_WINDOW_STATE_FAILED", error); }
}

// Page zoom is shared per host name in Chromium, so the default zoom menu would also zoom the 127.0.0.1 product
// preview under verification. The workbench scales itself instead; this menu keeps editing and developer entries only.
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "editMenu", label: "编辑" },
    { label: "开发", submenu: [
      { label: "重新载入工作台", accelerator: "CmdOrCtrl+R", click: () => shell?.webContents.reload() },
      { label: "工作台开发者工具", accelerator: "CmdOrCtrl+Shift+I", click: () => shell?.webContents.toggleDevTools() },
      { label: "预览开发者工具", click: () => preview?.webContents.toggleDevTools() },
    ] },
  ]));
}

function localPreviewUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" ? url.href : null;
  } catch { return null; }
}

if (!primary) {
  console.log("ALPHA_ALREADY_RUNNING");
  app.quit();
} else {
app.on("second-instance", () => window?.focus());
app.whenReady().then(async () => {
  try {
    app.setAppUserModelId("Alpha");
    const port = await startSidecar();
    installMenu();
    const saved = savedWindowState();
    window = new BaseWindow({ width: 1460, height: 900, ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}), minWidth: 1080, minHeight: 620, title: "Alpha", backgroundColor: "#0e1014", autoHideMenuBar: true });
    if (saved?.maximized) window.maximize();
    let saveTimer;
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 600); };
    for (const event of ["resize", "move", "maximize", "unmaximize"]) window.on(event, scheduleSave);
    window.on("close", () => { clearTimeout(saveTimer); saveWindowState(); });
    window.on("focus", () => window.flashFrame(false));
    shell = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    preview = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    window.contentView.addChildView(shell);
    window.contentView.addChildView(preview);
    // The workbench owns the whole window; it reports where the preview slot is and the preview view is placed over it.
    // A hidden preview gets empty bounds (View.setVisible(true) did not bring a hidden view back on Windows).
    preview.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    const layout = () => {
      const { width, height } = window.getContentBounds();
      shell.setBounds({ x: 0, y: 0, width, height });
    };
    layout();
    window.on("resize", layout);
    window.on("closed", () => {
      shell.webContents.close();
      preview.webContents.close();
      window = null;
    });
    shell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // Pinch zoom would change the page scale the verifier measures against.
    void shell.webContents.setVisualZoomLevelLimits(1, 1);
    void preview.webContents.setVisualZoomLevelLimits(1, 1);
    ipcMain.on("alpha:preview", (event, url) => {
      if (event.sender !== shell.webContents) return;
      const allowed = localPreviewUrl(url);
      if (allowed) void preview.webContents.loadURL(allowed);
    });
    ipcMain.on("alpha:preview-clear", event => {
      if (event.sender === shell.webContents) void preview.webContents.loadURL(emptyPreview);
    });
    ipcMain.on("alpha:preview-bounds", (event, value) => {
      if (event.sender !== shell.webContents || !window) return;
      const rect = previewBounds(value);
      if (!rect) return;
      const zoom = shell.webContents.getZoomFactor();
      const { width, height } = window.getContentBounds();
      const x = Math.min(Math.max(Math.round(rect.x * zoom), 0), width);
      const y = Math.min(Math.max(Math.round(rect.y * zoom), 0), height);
      const w = Math.min(Math.max(Math.round(rect.width * zoom), 0), width - x);
      const h = Math.min(Math.max(Math.round(rect.height * zoom), 0), height - y);
      preview.setBounds(rect.visible ? { x, y, width: w, height: h } : { x: 0, y: 0, width: 0, height: 0 });
    });
    ipcMain.handle("alpha:open-folder", async (event, directory) => {
      if (event.sender !== shell.webContents || typeof directory !== "string") return "不允许打开这个目录";
      try {
        const target = realpathSync(directory);
        const workspace = realpathSync(workspaceRoot);
        const data = realpathSync(path.join(workspaceRoot, ".alpha"));
        const products = realpathSync(path.join(workspaceRoot, "products"));
        const relative = path.relative(products, target);
        if (target !== workspace && target !== data && (relative.startsWith("..") || path.isAbsolute(relative))) return "目录不在 Alpha 工作区内";
        return await electronShell.openPath(target);
      } catch { return "目录不存在"; }
    });
    ipcMain.handle("alpha:open-external", async (event, value) => {
      if (event.sender !== shell.webContents || !localPreviewUrl(value)) return false;
      await electronShell.openExternal(value);
      return true;
    });
    ipcMain.handle("alpha:save-text", async (event, filename, content) => {
      if (event.sender !== shell.webContents || typeof filename !== "string" || typeof content !== "string" || content.length > 5_000_000) return false;
      const safeName = filename.replace(/[<>:"/\\|?*]/g, "_").slice(0, 100) || "alpha-report.md";
      const choice = await dialog.showSaveDialog(window, { defaultPath: safeName, filters: [{ name: "Markdown", extensions: ["md"] }] });
      if (choice.canceled || !choice.filePath) return false;
      writeFileSync(choice.filePath, content, "utf8");
      return true;
    });
    ipcMain.on("alpha:notify", (event, title, body, taskId) => {
      if (event.sender !== shell.webContents || window.isFocused() || !Notification.isSupported() ||
          typeof title !== "string" || typeof body !== "string" || !/^[0-9a-f-]{36}$/.test(taskId)) return;
      const notice = new Notification({ title: title.slice(0, 100), body: body.slice(0, 250) });
      notice.on("click", () => { window.show(); window.focus(); shell.webContents.send("alpha:open-task", taskId); });
      notice.show();
    });
    ipcMain.on("alpha:attention", event => {
      if (event.sender === shell.webContents && !window.isFocused()) window.flashFrame(true);
    });
    await preview.webContents.loadURL(emptyPreview);
    await shell.webContents.loadURL(`http://127.0.0.1:${port}/ui/`);
    console.log(`ALPHA_DESKTOP_READY ${port} ${cdpPort}`);
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
app.on("before-quit", () => sidecar?.kill());
