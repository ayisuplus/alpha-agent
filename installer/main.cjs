const { app, dialog } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function start() {
  const bundle = path.join(process.resourcesPath, "alpha");
  process.env.ALPHA_WORKSPACE_ROOT ??= path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "Alpha");
  const child = spawn(path.join(bundle, "node_modules", "electron", "dist", "electron.exe"), [path.join(bundle, "desktop", "main.cjs")], {
    cwd: bundle, env: { ...process.env, ALPHA_BUN_PATH: path.join(bundle, "runtime", "bun.exe") },
    detached: true, windowsHide: true, stdio: "ignore",
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref(); app.quit();
}

start().catch(error => {
  dialog.showErrorBox("Alpha 无法启动", String(error));
  app.exit(1);
});
