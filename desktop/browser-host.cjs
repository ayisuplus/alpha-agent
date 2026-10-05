// Alpha 浏览器宿主（独立 Electron 进程）：只承载智能体页面，OMP 原生 browser 工具经 CDP 连接本进程。
//
// 启动：由 desktop/main.cjs 用仓库/发行包内的 Electron 可执行文件拉起（开发与打包同一解析规则，见 main.cjs）。
// 窗口：常驻隐藏窗口，标题“Alpha 浏览器”，初始为空白页，不加载任何远程内容。
//
// 控制协议（父进程 → 宿主，127.0.0.1 控制端口上的逐行 JSON；连接断开即宿主退出——即父进程退出）：
//   {"op":"show","x":N,"y":N,"width":N,"height":N,"targetId"?:string}  接管：窗口移到该屏幕矩形并显示置前；
//                                                                     targetId 可选，指定置前的页面目标
//   {"op":"hide"}                                                     交还：重新隐藏（页面与登录态保持不变）
//   {"op":"quit"}                                                     退出
// stdout：启动完成后一行 `ALPHA_BROWSER_HOST_READY <cdpPort> <controlPort>`。
// 注 1：Windows 上 Electron（GUI 子系统）作为子进程时 process.stdin 立即 EOF，stdin 协议不可用，
//       故控制面改用回环 TCP（信任模型与 CDP 端口相同：仅本机可达）。
// 注 2：Chromium 对 OS 隐藏（win.hide()/最小化/透明）的窗口停止出帧，Page.startScreencast 会冻结；因此
//       “隐藏”＝窗口移到屏幕外 + 鼠标穿透 + 不进任务栏/Alt-Tab，窗口保持出帧，面板在接管前也能实时显示。
//
// CDP：remote-debugging-port=0（Chromium 只绑定 127.0.0.1 随机端口），端口读 userData/DevToolsActivePort。
// 页面：每个会话按需创建独立视图；CDP 代理将 Target.createTarget 与弹出页接入同一所有权模型。
// profile：`<workspaceRoot>/.alpha/browser-profile/`（与桌面界面配置分开；登录态随 profile 持久化）。

const { app, BaseWindow, WebContentsView, webContents } = require("electron");
const { mkdirSync, readFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { createInterface } = require("node:readline");
const path = require("node:path");
const { createBrowserProxy } = require("./browser-proxy.cjs");
// A failed isolated host reports to its parent and exits; Electron must not leave a modal error dialog.
process.on("uncaughtException", error => { console.error(`ALPHA_BROWSER_HOST_ERROR ${error.stack || error}`); app.exit(1); });

const root = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(process.env.ALPHA_WORKSPACE_ROOT || root);
const profile = path.join(workspaceRoot, ".alpha", "browser-profile");
mkdirSync(profile, { recursive: true });
// 可选 --cdp-port <n>：主进程为整个工作台生命周期固定端口，重启宿主后 OMP 的 browser.cdpUrl 不失效。
const cdpPortIndex = process.argv.indexOf("--cdp-port");
const cdpPortArg = cdpPortIndex >= 0 ? process.argv[cdpPortIndex + 1] : null;
const cdpPort = cdpPortArg && /^\d+$/.test(cdpPortArg) ? cdpPortArg : "0";
app.setName("AlphaBrowserHost");
app.setPath("userData", profile);
app.commandLine.appendSwitch("remote-debugging-port", "0");
// 后台视图继续出帧：接管前窗口隐藏、截屏流订阅时页面在后台，都不能停帧。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const OFFSCREEN = -32000; // 隐身位置：任何常规显示器布局之外（Windows 虚拟屏下限附近）
const pages = [];
const targetIds = new Map(); // webContents.id → CDP targetId（稳定不变）
let hostWindow = null;
let controlSession = null;
let frontView = null;
let quitting = false;
let manualTakeover = false;
let cancelInput = async () => {};

function readCdpPort() {
  const file = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const first = readFileSync(file, "utf8").split(/\r?\n/)[0];
      const port = Number(first);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error("浏览器宿主 CDP 端口未就绪（DevToolsActivePort）");
}

async function waitForCdp(port) {
  const probe = `http://127.0.0.1:${port}/json/version`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(probe);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("浏览器宿主 CDP 端点未响应");
}

async function targetIdForPage(view) {
  const key = view.webContents.id;
  const cached = targetIds.get(key);
  if (cached) return cached;
  const debuggerApi = view.webContents.debugger;
  const attached = debuggerApi.isAttached();
  if (!attached) debuggerApi.attach("1.3");
  try {
    const result = await debuggerApi.sendCommand("Target.getTargetInfo");
    const id = result?.targetInfo?.targetId;
    if (typeof id !== "string" || !id) throw new Error("页面目标身份不可用");
    targetIds.set(key, id);
    return id;
  } finally {
    if (!attached && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

function pageFrame() {
  const { width, height } = hostWindow.getContentBounds();
  return { x: 0, y: 0, width, height };
}

function bringToFront(targetId) {
  const hit = targetId ? pages.find(page => page.targetId === targetId) : null;
  const front = hit ?? pages[0];
  // 只在换层时重新加入：重复 addChildView 会重建合成目标，截屏流的帧源会断。
  if (!front || front.view === frontView) return;
  hostWindow.contentView.addChildView(front.view);
  frontView = front.view;
}

function resolveTarget(targetId) {
  const known = pages.find(page => page.targetId === targetId);
  if (known) return known;
  let contents; try { contents = webContents.fromDevToolsTargetId(targetId); } catch { return undefined; }
  const page = contents && pages.find(page => page.view.webContents === contents);
  if (page) page.targetId = targetId;
  return page;
}

function closePage(targetId) {
  const page = resolveTarget(targetId);
  if (!page) return false;
  page.view.webContents.close({ waitForBeforeUnload: false });
  return true;
}

/** 隐身（交还）：窗口移出所有显示器（用户看不见、点不到、不进任务栏），但保持出帧，截屏流实时。
 *  不用 win.hide()/最小化/透明度：Chromium 对这些状态的窗口停止出帧，Page.startScreencast 会冻结。 */
async function enterHiddenMode() {
  manualTakeover = true;
  await cancelInput();
  manualTakeover = false;
  hostWindow.setIgnoreMouseEvents(true);
  hostWindow.setSkipTaskbar(true);
  const [width, height] = hostWindow.getSize();
  hostWindow.setBounds({ x: OFFSCREEN, y: OFFSCREEN, width, height });
}

function enterVisibleMode() {
  hostWindow.setSkipTaskbar(false);
  hostWindow.setIgnoreMouseEvents(false);
}

async function applyShow(message) {
  const numbers = ["x", "y", "width", "height"].map(key => Number(message[key]));
  if (!numbers.every(Number.isFinite)) return;
  const [x, y, width, height] = numbers.map(Math.round);
  if (width < 120 || height < 80) return;
  manualTakeover = true;
  await cancelInput();
  hostWindow.setBounds({ x, y, width, height });
  for (const page of pages) page.view.setBounds(pageFrame());
  bringToFront(typeof message.targetId === "string" ? message.targetId : undefined);
  enterVisibleMode();
  hostWindow.show();
  hostWindow.focus();
  hostWindow.moveTop();
}

function managePage(owner, view) {
  // Register behind the active view. Only coordinated input or an explicit takeover raises it.
  hostWindow.contentView.addChildView(view, 0); view.setBounds(pageFrame());
  if (!frontView) frontView = view;
  const contentsId = view.webContents.id;
  const page = { view, owner, targetId: null };
  pages.push(page);
  view.webContents.once("destroyed", () => { const index = pages.indexOf(page); if (index >= 0) pages.splice(index, 1); targetIds.delete(contentsId); if (frontView === view) frontView = null; if (!hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(view); });
  view.webContents.setWindowOpenHandler(details => ({ action: "allow", createWindow: options => {
    const popup = new WebContentsView({ webContents: options.webContents, webPreferences: { ...options.webPreferences, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const entry = managePage(owner, popup);
    void targetIdForPage(popup).then(id => { entry.targetId = id; });
    if (details.disposition === "background-tab") void popup.webContents.loadURL(details.url);
    return popup.webContents;
  } }));
  return page;
}

async function createPage(owner, url) {
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const page = managePage(owner, view);
  page.targetId = await targetIdForPage(view);
  await view.webContents.loadURL(url);
  return page;
}

async function checkInput(targetId, x, y) {
  const page = pages.find(page => page.targetId === targetId);
  if (!page || !Number.isFinite(x) || !Number.isFinite(y)) throw Error("Input requires a valid owned page point");
  const disabled = await page.view.webContents.executeJavaScript(`(() => {
    function hit(doc,x,y) {
      let element=doc.elementFromPoint(x,y);
      while(element?.shadowRoot) { const child=element.shadowRoot.elementFromPoint(x,y); if(!child||child===element)break; element=child; }
      if(element?.tagName==='IFRAME' && element.contentDocument) { const box=element.getBoundingClientRect(); return hit(element.contentDocument,x-box.left-element.clientLeft,y-box.top-element.clientTop); }
      return !!element && (element.matches(':disabled') || !!element.closest('[aria-disabled="true"],[inert]'));
    }
    return hit(document,${x},${y});
  })()`);
  if (disabled) throw Error("Click target is disabled");
}

async function resetInput(targetId, buttons, keys) {
  const page = resolveTarget(targetId);
  if (!page || page.view.webContents.isDestroyed()) return;
  const debuggerApi = page.view.webContents.debugger;
  const attached = debuggerApi.isAttached();
  if (!attached) debuggerApi.attach("1.3");
  try {
    // Release outside the viewport so even a full-page button cannot complete its click.
    if (buttons.length) await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: -1, y: -1 });
    for (const button of buttons) await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: -1, y: -1, button, buttons: 0 });
    for (const key of keys) await debuggerApi.sendCommand("Input.dispatchKeyEvent", { ...key, type: "keyUp", modifiers: 0, text: "", unmodifiedText: "" });
  } finally { if (!attached && debuggerApi.isAttached()) debuggerApi.detach(); }
}

function handleCommand(message) {
  if (!message || typeof message !== "object") return;
  if (message.op === "show") return applyShow(message);
  else if (message.op === "hide") return enterHiddenMode();
  else if (message.op === "quit") { quitting = true; app.quit(); }
}

app.whenReady().then(async () => {
  hostWindow = new BaseWindow({ show: false, width: 1280, height: 800, title: "Alpha 浏览器" });
  // Session allocation creates pages on demand; no unowned page can be adopted by two OMP processes.
  hostWindow.on("resize", () => { for (const page of pages) page.view.setBounds(pageFrame()); });
  // 关闭按钮等于“交还”：窗口转隐身、页面与登录态保活；只有 quit/控制连接断开才真正结束。
  hostWindow.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    void enterHiddenMode();
  });
  bringToFront(undefined); // 默认前置第一页（此后换层才重新加入视图）
  // 启动即隐身出帧：面板在首次“接管”前就能实时显示页面。
  await enterHiddenMode();
  hostWindow.show();

  const port = readCdpPort();
  await waitForCdp(port);
  const proxy = await createBrowserProxy({ rawPort: port, port: Number(cdpPort), registryFile: path.join(profile, "session-ports.json"), pages: () => pages, resolveTarget,
    createPage, closePage, activate: bringToFront, checkInput, resetInput, manual: () => manualTakeover });
  cancelInput = proxy.cancelInput;

  // 控制面：仅 127.0.0.1。父进程（desktop/main.cjs）保持一条连接；连接断开即视为父进程退出。
  const control = createServer(socket => {
    if (controlSession) { socket.destroy(); return; } // 单会话：只服务父进程的第一条连接
    controlSession = socket;
    let commands = Promise.resolve();
    const input = createInterface({ input: socket });
    input.on("line", line => {
      try {
        const message = JSON.parse(line);
        commands = commands.then(() => handleCommand(message)).catch(error => console.error(`ALPHA_BROWSER_CONTROL_ERROR ${error.message}`));
      } catch { /* 非法行忽略 */ }
    });
    socket.on("close", () => { if (!quitting) { quitting = true; app.quit(); } });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", () => { control.off("error", reject); resolve(); });
  });
  console.log(`ALPHA_BROWSER_HOST_READY ${proxy.port} ${control.address().port}`);
}).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
