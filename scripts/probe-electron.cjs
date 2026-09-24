const { app, BaseWindow, WebContentsView } = require("electron");

const port = process.env.ALPHA_CDP_PORT;
if (!port) throw new Error("ALPHA_CDP_PORT is required");
app.commandLine.appendSwitch("remote-debugging-port", port);

let window;
let shell;
let preview;

app.whenReady().then(async () => {
  window = new BaseWindow({ width: 1000, height: 640, title: "Alpha browser probe" });
  shell = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  preview = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.contentView.addChildView(shell);
  window.contentView.addChildView(preview);
  shell.setBounds({ x: 0, y: 0, width: 260, height: 640 });
  preview.setBounds({ x: 260, y: 0, width: 740, height: 640 });
  await shell.webContents.loadURL("data:text/html," + encodeURIComponent("<title>alpha-shell-probe</title><h1>Alpha</h1><p>Visible preview at right</p>"));
  await preview.webContents.loadURL(process.env.ALPHA_PREVIEW_URL || "data:text/html," + encodeURIComponent("<title>alpha-preview-probe</title><button id='increment'>Increment</button><strong id='count'>0</strong><script>let n=0;document.getElementById('increment').onclick=()=>{document.getElementById('count').textContent=String(++n);console.log('ALPHA_PREVIEW_COUNT='+n)}</script>"));
  const watch = setInterval(async () => {
    if (preview.webContents.isDestroyed()) return clearInterval(watch);
    const count = await preview.webContents.executeJavaScript("document.querySelector('#count')?.textContent").catch(() => null);
    if (count === "1") {
      console.log("ALPHA_PREVIEW_COUNT=1");
      clearInterval(watch);
    }
  }, 50);
  console.log("ALPHA_ELECTRON_READY");
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (shell && !shell.webContents.isDestroyed()) shell.webContents.close();
  if (preview && !preview.webContents.isDestroyed()) preview.webContents.close();
});
