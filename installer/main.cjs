const { app, dialog } = require("electron");
const path = require("node:path");

async function start() {
  const bundle = path.join(process.resourcesPath, "alpha");
  process.env.ALPHA_WORKSPACE_ROOT ??= path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "Alpha");
  process.env.ALPHA_BUN_PATH = path.join(bundle, "runtime", "bun.exe");
  require(path.join(bundle, "desktop", "main.cjs"));
}

start().catch(error => {
  dialog.showErrorBox("Alpha 无法启动", String(error));
  app.exit(1);
});
