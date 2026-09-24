const { app, BaseWindow, dialog, ipcMain, WebContentsView } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync } = require("node:fs");
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

let sidecar;
let window;
let shell;
let preview;
const emptyPreview = "data:text/html," + encodeURIComponent("<title>Alpha preview</title><style>body{font-family:system-ui;background:#f6f7f9;color:#4d5968;display:grid;place-items:center;height:100vh;margin:0}</style><p>选择任务后，产品预览将在这里打开</p>");

function startSidecar() {
  return new Promise((resolve, reject) => {
    const executable = process.env.ALPHA_BUN_PATH || "bun";
    sidecar = spawn(executable, ["run", "src/server.ts"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    const port = await startSidecar();
    window = new BaseWindow({ width: 1460, height: 900, minWidth: 1080, minHeight: 620, title: "Alpha", backgroundColor: "#0e1014", autoHideMenuBar: true });
    shell = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    preview = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
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
