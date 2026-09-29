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
// 页面：窗口内预置 PAGE_COUNT 个空白页面视图作为可被 OMP 采用的 CDP page 目标——Electron 的 CDP 不支持
// Target.createTarget，OMP 的 connected 模式（browser.cdpUrl）只能复用已有的 page 目标（每页一个）。
// profile：`<workspaceRoot>/.alpha/browser-profile/`（与桌面界面配置分开；登录态随 profile 持久化）。

const { app, BaseWindow, WebContentsView } = require("electron");
const { mkdirSync, readFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { createInterface } = require("node:readline");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(process.env.ALPHA_WORKSPACE_ROOT || root);
const profile = path.join(workspaceRoot, ".alpha", "browser-profile");
mkdirSync(profile, { recursive: true });
app.setName("AlphaBrowserHost");
app.setPath("userData", profile);
app.commandLine.appendSwitch("remote-debugging-port", "0");
// 后台视图继续出帧：接管前窗口隐藏、截屏流订阅时页面在后台，都不能停帧。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

const PAGE_COUNT = 3;
const OFFSCREEN = -32000; // 隐身位置：任何常规显示器布局之外（Windows 虚拟屏下限附近）
const pages = [];
const targetIds = new Map(); // webContents.id → CDP targetId（稳定不变）
let hostWindow = null;
let controlSession = null;
let frontView = null;
let quitting = false;

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

/** 隐身（交还）：窗口移出所有显示器（用户看不见、点不到、不进任务栏），但保持出帧，截屏流实时。
 *  不用 win.hide()/最小化/透明度：Chromium 对这些状态的窗口停止出帧，Page.startScreencast 会冻结。 */
function enterHiddenMode() {
  hostWindow.setIgnoreMouseEvents(true);
  hostWindow.setSkipTaskbar(true);
  const [width, height] = hostWindow.getSize();
  hostWindow.setBounds({ x: OFFSCREEN, y: OFFSCREEN, width, height });
}

function enterVisibleMode() {
  hostWindow.setSkipTaskbar(false);
  hostWindow.setIgnoreMouseEvents(false);
}

function applyShow(message) {
  const numbers = ["x", "y", "width", "height"].map(key => Number(message[key]));
  if (!numbers.every(Number.isFinite)) return;
  const [x, y, width, height] = numbers.map(Math.round);
  if (width < 120 || height < 80) return;
  hostWindow.setBounds({ x, y, width, height });
  for (const page of pages) page.view.setBounds(pageFrame());
  bringToFront(typeof message.targetId === "string" ? message.targetId : undefined);
  enterVisibleMode();
  hostWindow.show();
  hostWindow.focus();
  hostWindow.moveTop();
}

function handleCommand(message) {
  if (!message || typeof message !== "object") return;
  if (message.op === "show") applyShow(message);
  else if (message.op === "hide") enterHiddenMode();
  else if (message.op === "quit") { quitting = true; app.quit(); }
}

app.whenReady().then(async () => {
  hostWindow = new BaseWindow({ show: false, width: 1280, height: 800, title: "Alpha 浏览器" });
  for (let index = 0; index < PAGE_COUNT; index++) {
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    hostWindow.contentView.addChildView(view);
    view.setBounds(pageFrame());
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    pages.push({ view, targetId: null });
  }
  hostWindow.on("resize", () => { for (const page of pages) page.view.setBounds(pageFrame()); });
  // 关闭按钮等于“交还”：窗口转隐身、页面与登录态保活；只有 quit/控制连接断开才真正结束。
  hostWindow.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    enterHiddenMode();
  });
  for (const page of pages) await page.view.webContents.loadURL("about:blank");
  for (const page of pages) page.targetId = await targetIdForPage(page.view);
  bringToFront(undefined); // 默认前置第一页（此后换层才重新加入视图）
  // 启动即隐身出帧：面板在首次“接管”前就能实时显示页面。
  enterHiddenMode();
  hostWindow.show();

  const port = readCdpPort();
  await waitForCdp(port);

  // 控制面：仅 127.0.0.1。父进程（desktop/main.cjs）保持一条连接；连接断开即视为父进程退出。
  const control = createServer(socket => {
    if (controlSession) { socket.destroy(); return; } // 单会话：只服务父进程的第一条连接
    controlSession = socket;
    const input = createInterface({ input: socket });
    input.on("line", line => {
      try { handleCommand(JSON.parse(line)); } catch { /* 非法行忽略 */ }
    });
    socket.on("close", () => { if (!quitting) { quitting = true; app.quit(); } });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(0, "127.0.0.1", () => { control.off("error", reject); resolve(); });
  });
  console.log(`ALPHA_BROWSER_HOST_READY ${port} ${control.address().port}`);
}).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  app.exit(1);
});
