const { contextBridge, ipcRenderer } = require("electron");

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
