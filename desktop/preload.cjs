// 桌面 preload：渲染进程唯一可用的原生接口（contextBridge，window.alpha）。
//
// ══ IPC 契约（M4 浏览器面板用；主进程实现在 desktop/main.cjs）════════════════════════════════
// invoke（window.alpha.<fn>）：
//   browserHostStatus(): Promise<BrowserHostStatus>
//     BrowserHostStatus = { available: boolean, port: number | null, reason?: string }
//     available=false 时面板显示“当前为不可见模式”（reason 给出原因）。
//   browserTabs(): Promise<{ available: boolean, tabs: Array<{ targetId: string, url: string, title: string }>, error?: string }>
//     列出 Alpha 浏览器宿主中的页面（CDP page 目标）；宿主不可用时 available=false 且 tabs=[]。
//   browserScreencast(request: { action: "start" | "stop", targetId: string, maxDimension?: number }): Promise<{ ok: boolean, error?: string }>
//     start：订阅该页面的 CDP Page.startScreencast，只读 JPEG 帧流经 onBrowserScreencastFrame 推送；
//     stop：停止订阅。maxDimension 可选（160–2560，默认 1280），帧等比缩放至该尺寸内。
//   browserTakeover(request: { rect: { x: number, y: number, width: number, height: number }, targetId?: string }): Promise<{ ok: boolean, error?: string }>
//     “接管”：宿主窗口移到面板矩形并显示置前。rect 为工作台内容区 CSS 像素（主进程按缩放因子
//     换算为屏幕坐标）；targetId 可选，指定接管时置前的页面目标。
//   browserHandback(): Promise<{ ok: boolean, error?: string }>
//     “交还”：宿主窗口重新隐藏；页面、Cookie 与登录态保持不变，智能体继续使用。
//
// 事件（on… 返回退订函数）：
//   onBrowserScreencastFrame(callback: (frame: BrowserScreencastFrame) => void): () => void
//     BrowserScreencastFrame = {
//       targetId: string, format: "jpeg",
//       data: string | null,          // base64 JPEG；null = 该目标帧流结束（见 error）
//       error?: string,
//       metadata: { offsetTop, pageScaleFactor, deviceWidth, deviceHeight,
//                   scrollOffsetX, scrollOffsetY, timestamp },
//     }
//   onBrowserHostStatusChanged(callback: (status: BrowserHostStatus) => void): () => void
//     宿主启动/退出时推送，与 browserHostStatus() 同形状。
//
// 其余保留接口：
//   openFolder(path) / revealItem(path) / openExternal(url) / saveText(filename, content) → invoke
//   notify(title, body, taskId) / attention() → send（无返回）
//   onOpenTask(callback) → 事件 alpha:open-task，返回退订函数
// ══════════════════════════════════════════════════════════════════════════════════════════════
const { contextBridge, ipcRenderer } = require("electron");

function onEvent(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("alpha", {
  storage(operation, key, value) {
    return ipcRenderer.sendSync("alpha:storage", operation, key, value);
  },
  serverToken() {
    return ipcRenderer.invoke("alpha:server-token");
  },
  openFolder(path) {
    return ipcRenderer.invoke("alpha:open-folder", path);
  },
  choosePaths(kind) {
    return ipcRenderer.invoke("alpha:choose-paths", kind);
  },
  revealItem(path) {
    return ipcRenderer.invoke("alpha:reveal-item", path);
  },
  openEditor(path) {
    return ipcRenderer.invoke("alpha:open-editor", path);
  },
  openExternal(url) {
    return ipcRenderer.invoke("alpha:open-external", url);
  },
  saveText(filename, content) {
    return ipcRenderer.invoke("alpha:save-text", filename, content);
  },
  notify(title, body, taskId) {
    ipcRenderer.send("alpha:notify", title, body, taskId);
  },
  attention() {
    ipcRenderer.send("alpha:attention");
  },
  onOpenTask(callback) {
    return onEvent("alpha:open-task", callback);
  },
  browserHostStatus() {
    return ipcRenderer.invoke("alpha:browser-host-status");
  },
  browserHostRestart() {
    return ipcRenderer.invoke("alpha:browser-host-restart");
  },
  browserTabs() {
    return ipcRenderer.invoke("alpha:browser-tabs");
  },
  browserScreencast(request) {
    return ipcRenderer.invoke("alpha:browser-screencast", request);
  },
  browserTakeover(request) {
    return ipcRenderer.invoke("alpha:browser-takeover", request);
  },
  browserHandback() {
    return ipcRenderer.invoke("alpha:browser-handback");
  },
  onBrowserScreencastFrame(callback) {
    return onEvent("alpha:browser-screencast-frame", callback);
  },
  onBrowserHostStatusChanged(callback) {
    return onEvent("alpha:browser-host-status-changed", callback);
  },
});
