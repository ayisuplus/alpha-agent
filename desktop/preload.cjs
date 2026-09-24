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
});
