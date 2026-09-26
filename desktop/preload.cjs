const { contextBridge, ipcRenderer } = require("electron");
const pendingWebTabs = new Map();
let webTabListener = null;
ipcRenderer.on("alpha:web-tab-request", (_event, request) => {
  if (webTabListener) webTabListener(request);
  else pendingWebTabs.set(request.tabId, request);
});
ipcRenderer.on("alpha:web-tab-closed", (_event, tabId) => pendingWebTabs.delete(tabId));

contextBridge.exposeInMainWorld("alpha", {
  loadPreview(url) {
    ipcRenderer.send("alpha:preview", url);
  },
  clearPreview() {
    ipcRenderer.send("alpha:preview-clear");
  },
  setPreviewBounds(rect) {
    ipcRenderer.send("alpha:preview-bounds", rect);
  },
  setWebBounds(tabId, rect) {
    ipcRenderer.send("alpha:web-bounds", tabId, rect);
  },
  onWebTabRequested(callback) {
    webTabListener = callback;
    for (const request of pendingWebTabs.values()) callback(request);
    pendingWebTabs.clear();
    return () => { if (webTabListener === callback) webTabListener = null; };
  },
  onWebTabClosed(callback) {
    const listener = (_event, tabId) => callback(tabId);
    ipcRenderer.on("alpha:web-tab-closed", listener);
    return () => ipcRenderer.removeListener("alpha:web-tab-closed", listener);
  },
  openFolder(path) {
    return ipcRenderer.invoke("alpha:open-folder", path);
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
    const listener = (_event, taskId) => callback(taskId);
    ipcRenderer.on("alpha:open-task", listener);
    return () => ipcRenderer.removeListener("alpha:open-task", listener);
  },
});
