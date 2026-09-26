const { app, dialog } = require("electron");
const { createServer } = require("node:net");
const path = require("node:path");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function start() {
  const bundle = path.join(process.resourcesPath, "alpha");
  process.env.ALPHA_WORKSPACE_ROOT ??= path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "Alpha");
  process.env.ALPHA_BUN_PATH = path.join(bundle, "runtime", "bun.exe");
  process.env.ALPHA_CDP_PORT = String(await freePort());
  require(path.join(bundle, "desktop", "main.cjs"));
}

start().catch(error => {
  dialog.showErrorBox("Alpha 无法启动", String(error));
  app.exit(1);
});
