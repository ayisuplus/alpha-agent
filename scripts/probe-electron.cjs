const { app, BaseWindow, WebContentsView } = require("electron");

const port = process.env.ALPHA_CDP_PORT;
if (!port) throw new Error("ALPHA_CDP_PORT is required");
app.commandLine.appendSwitch("remote-debugging-port", port);
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

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
  await preview.webContents.loadURL(process.env.ALPHA_PREVIEW_URL || "data:text/html," + encodeURIComponent("<title>alpha-preview-probe</title><button id='increment'>Increment</button><strong id='count'>0</strong><input id='query'><strong id='submitted'></strong><input id='upload' type='file'><strong id='uploaded'></strong><a id='download' href='data:text/plain,download-content' download='probe.txt'>Download</a><script>let n=0;document.getElementById('increment').onclick=()=>{document.getElementById('count').textContent=String(++n);console.log('ALPHA_PREVIEW_COUNT='+n)};document.getElementById('query').onkeydown=e=>{if(e.key==='Enter')document.getElementById('submitted').textContent=e.target.value};document.getElementById('upload').onchange=e=>document.getElementById('uploaded').textContent=e.target.files[0]?.name||''</script>"));
  preview.webContents.focus();
  if (!process.env.ALPHA_PREVIEW_URL) await preview.webContents.executeJavaScript(`new Promise(resolve => {
    const host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({mode:'open'});
    const button = document.createElement('button'); button.id = 'shadow-button'; button.textContent = 'Shadow'; button.onclick = () => button.textContent = 'Shadow clicked'; shadow.append(button);
    const frame = document.createElement('iframe'); frame.onload = resolve;
    frame.srcdoc = '<button id="frame-button" onclick="this.textContent=&quot;Frame clicked&quot;">Frame</button>';
    document.body.append(frame);
  })`);
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
