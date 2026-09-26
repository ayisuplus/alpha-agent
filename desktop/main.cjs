const { app, BaseWindow, dialog, ipcMain, Menu, Notification, safeStorage, screen, shell: electronShell, WebContentsView } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } = require("node:fs");
const { randomBytes, randomUUID } = require("node:crypto");
const { lookup } = require("node:dns").promises;
const http = require("node:http");
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
let browserBridge;
let bridgePort;
const bridgeToken = randomBytes(32).toString("hex");
const webTabs = new Map();
const webAllowed = new Map();
let visibleWebTab = null;
const webSecretsFile = path.join(workspaceRoot, ".alpha", "web-secrets.json");

function webSecrets() {
  try { return JSON.parse(readFileSync(webSecretsFile, "utf8")); } catch { return {}; }
}

function saveWebSecrets(secrets) {
  const temp = `${webSecretsFile}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(secrets), { flag: "wx" });
  renameSync(temp, webSecretsFile);
}

async function targetId(webContents) {
  const debuggerApi = webContents.debugger;
  const attached = debuggerApi.isAttached();
  if (!attached) debuggerApi.attach("1.3");
  try {
    const result = await debuggerApi.sendCommand("Target.getTargetInfo");
    const id = result?.targetInfo?.targetId;
    if (typeof id !== "string" || !id) throw new Error("Browser target identity is unavailable");
    return id;
  } finally {
    if (!attached && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

function webUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname !== "localhost" ? url.href : null;
  } catch { return null; }
}

function closeWebTab(tabId) {
  const tab = webTabs.get(tabId);
  if (!tab) return;
  webTabs.delete(tabId);
  webAllowed.delete(tabId);
  if (visibleWebTab === tabId) visibleWebTab = null;
  if (window && !window.isDestroyed()) window.contentView.removeChildView(tab.view);
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  if (shell && !shell.webContents.isDestroyed()) shell.webContents.send("alpha:web-tab-closed", tabId);
}

async function createWebTab(url, taskId) {
  if (webTabs.size >= 18) throw new Error("Alpha has reached the browser tab limit");
  if (!window || !/^[0-9a-f-]{36}$/.test(taskId)) throw new Error("Browser tab has no desktop task owner");
  const safeUrl = webUrl(url);
  if (!safeUrl) throw new Error("Web tabs require a public HTTPS URL");
  const tabId = randomUUID();
  const view = new WebContentsView({ webPreferences: { partition: "persist:alpha-web", contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  webTabs.set(tabId, { view, taskId });
  webAllowed.set(tabId, new Set([new URL(safeUrl).origin]));
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shell?.webContents.send("alpha:web-tab-request", { taskId, tabId });
  try {
    await new Promise((resolve, reject) => {
      const contents = view.webContents;
      let settled = false;
      let readyTimer;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(readyTimer);
        contents.off("did-navigate", onNavigate);
        contents.off("dom-ready", onReady);
        contents.off("did-fail-load", onFailure);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onNavigate = (_event, url) => {
        if (url.startsWith("https:") && !readyTimer) readyTimer = setTimeout(() => finish(), 4_000);
      };
      const onReady = () => { if (contents.getURL().startsWith("https:")) finish(); };
      const onFailure = (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) finish(new Error(`Web page load failed: ${description}`));
      };
      const timer = setTimeout(() => finish(new Error(`Web page load timed out: ${contents.getURL()}`)), 20_000);
      contents.on("did-navigate", onNavigate);
      contents.on("dom-ready", onReady);
      contents.on("did-fail-load", onFailure);
      void contents.loadURL(safeUrl).then(() => finish(), error => finish(error));
    });
    const tab = { tabId, targetId: await targetId(view.webContents), url: view.webContents.getURL(), title: view.webContents.getTitle() };
    return tab;
  } catch (error) {
    closeWebTab(tabId);
    throw error;
  }
}

function publicAddress(address) {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("::ffff:") || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")) return false;
  const bytes = address.split(".").map(Number);
  if (bytes.length !== 4) return true;
  const [a, b] = bytes;
  return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0)) && !(a === 198 && (b === 18 || b === 19));
}

function installWebRequestBoundary() {
  const { session } = require("electron");
  session.fromPartition("persist:alpha-web").webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    void (async () => {
      try {
        const url = new URL(details.url);
        if (!["http:", "https:"].includes(url.protocol)) return details.resourceType === "mainFrame" || url.protocol === "file:";
        if (url.hostname === "localhost" || url.hostname.endsWith(".local")) return true;
        const addresses = await lookup(url.hostname, { all: true });
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return true;
        const owner = [...webTabs].find(([, tab]) => tab.view.webContents.id === details.webContentsId);
        return details.resourceType === "mainFrame" && owner && !webAllowed.get(owner[0])?.has(url.origin);
      } catch { return true; }
    })().then(cancel => callback({ cancel }), () => callback({ cancel: true }));
  });
}

function bridgeResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function startBrowserBridge() {
  browserBridge = http.createServer(async (request, response) => {
    if (request.headers["x-alpha-bridge-token"] !== bridgeToken) return bridgeResponse(response, 403, { error: "Forbidden" });
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 16_000) throw new Error("Bridge request too large");
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (url.pathname === "/tabs" && request.method === "POST") return bridgeResponse(response, 200, await createWebTab(body.url, body.taskId));
      if (url.pathname === "/tabs" && request.method === "GET") {
        const tabs = await Promise.all([...webTabs].map(async ([tabId, tab]) => ({ tabId, targetId: await targetId(tab.view.webContents), url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() })));
        return bridgeResponse(response, 200, { tabs });
      }
      const tab = /^\/tabs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (tab && webTabs.has(tab[1])) {
        if (request.method === "POST") {
          const owner = webTabs.get(tab[1]);
          window?.focus();
          shell?.webContents.send("alpha:web-tab-request", { taskId: owner.taskId, tabId: tab[1] });
          return bridgeResponse(response, 200, { focused: true });
        }
        if (request.method === "DELETE") { closeWebTab(tab[1]); return bridgeResponse(response, 200, { closed: true }); }
      }
      const allow = /^\/tabs\/([0-9a-f-]{36})\/allow$/.exec(url.pathname);
      if (allow && request.method === "POST" && webAllowed.has(allow[1])) {
        const origin = webUrl(body.url);
        if (!origin) throw new Error("Invalid browser navigation URL");
        webAllowed.get(allow[1]).add(new URL(origin).origin);
        return bridgeResponse(response, 200, { allowed: true });
      }
      if (url.pathname === "/preview-target" && request.method === "GET" && preview) return bridgeResponse(response, 200, { targetId: await targetId(preview.webContents), url: preview.webContents.getURL() });
      const secret = /^\/secrets\/(tavily|firecrawl)$/.exec(url.pathname);
      if (secret) {
        if (request.method === "GET") {
          const ciphertext = webSecrets()[secret[1]];
          return bridgeResponse(response, 200, { key: ciphertext && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(ciphertext, "base64")) : null });
        }
        if (request.method === "PUT") {
          if (!safeStorage.isEncryptionAvailable()) throw new Error("System credential encryption is unavailable");
          if (typeof body.key !== "string" || body.key.trim().length < 8 || body.key.length > 1000) throw new Error("Invalid provider key");
          const secrets = webSecrets();
          secrets[secret[1]] = safeStorage.encryptString(body.key.trim()).toString("base64");
          saveWebSecrets(secrets);
          return bridgeResponse(response, 200, { saved: true });
        }
        if (request.method === "DELETE") {
          const secrets = webSecrets();
          delete secrets[secret[1]];
          saveWebSecrets(secrets);
          return bridgeResponse(response, 200, { removed: true });
        }
      }
      return bridgeResponse(response, 404, { error: "Not found" });
    } catch (error) {
      return bridgeResponse(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    browserBridge.once("error", reject);
    browserBridge.listen(0, "127.0.0.1", () => { browserBridge.off("error", reject); resolve(); });
  });
  bridgePort = browserBridge.address().port;
}
const emptyPreview = "data:text/html," + encodeURIComponent("<title>Alpha preview</title><style>body{font-family:system-ui;background:#f6f7f9;color:#4d5968;display:grid;place-items:center;height:100vh;margin:0}</style><p>选择任务后，产品预览将在这里打开</p>");

function startSidecar() {
  return new Promise((resolve, reject) => {
    const executable = process.env.ALPHA_BUN_PATH || "bun";
    sidecar = spawn(executable, ["run", "src/server.ts"], { cwd: root, env: { ...process.env, ALPHA_ELECTRON_VERSION: process.versions.electron, ALPHA_BROWSER_BRIDGE_PORT: String(bridgePort), ALPHA_BROWSER_BRIDGE_TOKEN: bridgeToken }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

function nativeBounds(rect) {
  const zoom = shell.webContents.getZoomFactor();
  const { width, height } = window.getContentBounds();
  const x = Math.min(Math.max(Math.round(rect.x * zoom), 0), width);
  const y = Math.min(Math.max(Math.round(rect.y * zoom), 0), height);
  return { x, y, width: Math.min(Math.max(Math.round(rect.width * zoom), 0), width - x), height: Math.min(Math.max(Math.round(rect.height * zoom), 0), height - y) };
}

function hideWebTab() {
  if (visibleWebTab && webTabs.has(visibleWebTab)) webTabs.get(visibleWebTab).view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  visibleWebTab = null;
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
    installWebRequestBoundary();
    await startBrowserBridge();
    const port = await startSidecar();
    installMenu();
    const saved = savedWindowState();
    window = new BaseWindow({ width: 1460, height: 900, ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}), minWidth: 1080, minHeight: 620, title: "Alpha", backgroundColor: "#faf9f6", autoHideMenuBar: true });
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
      for (const tabId of [...webTabs.keys()]) closeWebTab(tabId);
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
      if (rect.visible) hideWebTab();
      const wasHidden = preview.getBounds().width === 0;
      preview.setBounds(rect.visible ? nativeBounds(rect) : { x: 0, y: 0, width: 0, height: 0 });
      if (rect.visible && wasHidden) preview.webContents.focus();
    });
    ipcMain.on("alpha:web-bounds", (event, tabId, value) => {
      if (event.sender !== shell.webContents || !window) return;
      if (tabId === null) { hideWebTab(); return; }
      const rect = previewBounds(value);
      if (!rect || !webTabs.has(tabId)) return;
      if (!rect.visible) {
        if (visibleWebTab === tabId) hideWebTab();
        return;
      }
      const changed = visibleWebTab !== tabId;
      if (changed) hideWebTab();
      preview.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      webTabs.get(tabId).view.setBounds(nativeBounds(rect));
      visibleWebTab = tabId;
      if (changed) webTabs.get(tabId).view.webContents.focus();
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
app.on("before-quit", () => { sidecar?.kill(); browserBridge?.close(); });
