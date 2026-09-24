import { createServer } from "node:net";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { discoverBrowserWebSocket, VisibleBrowser } from "../src/runtime/visible-browser";

function bounded<T>(name: string, promise: Promise<T>, timeoutMs = 10_000): Promise<T> {
  return Promise.race([promise, Bun.sleep(timeoutMs).then(() => { throw new Error(`Timed out: ${name}`); })]);
}

const server = createServer();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not reserve probe port");
const port = address.port;
await new Promise<void>(resolve => server.close(() => resolve()));

const env: NodeJS.ProcessEnv = { ...process.env, ALPHA_CDP_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
const electron = join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");
const child = Bun.spawn([electron, join(process.cwd(), "scripts", "probe-electron.cjs")], {
  cwd: process.cwd(),
  env,
  stdout: "pipe",
  stderr: "pipe",
});

let output = "";
let errors = "";
const reader = (async () => {
  for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
})();
const errorReader = (async () => {
  for await (const chunk of child.stderr) errors = (errors + new TextDecoder().decode(chunk)).slice(-4000);
})();
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
let visible: VisibleBrowser | undefined;
try {
  const cdpUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (output.includes("ALPHA_ELECTRON_READY")) break;
    if (child.exitCode !== null) throw new Error(`Electron exited early: ${output}`);
    await Bun.sleep(100);
  }
  if (!output.includes("ALPHA_ELECTRON_READY")) throw new Error(`Electron did not become ready: ${output}`);
  let webSocket: string | undefined;
  const endpointDeadline = Date.now() + 30_000;
  while (Date.now() < endpointDeadline) {
    webSocket = await discoverBrowserWebSocket(cdpUrl).catch(() => undefined);
    if (webSocket) break;
    await Bun.sleep(100);
  }
  if (!webSocket) throw new Error(`Electron CDP endpoint ${cdpUrl} not ready: ${errors}`);
  browser = await bounded("manual browser connect", puppeteer.connect({ browserWSEndpoint: webSocket, defaultViewport: null }), 30_000);
  console.error("manual browser connected");
  visible = await bounded("Alpha browser connect", VisibleBrowser.connect(cdpUrl, "alpha-preview-probe"), 30_000);
  console.error("Alpha browser connected");
  const pages = await browser.pages();
  const titles = await Promise.all(pages.map(page => page.title()));
  const previewIndex = titles.indexOf("alpha-preview-probe");
  if (previewIndex < 0 || !titles.includes("alpha-shell-probe")) throw new Error(`Expected shell and preview targets: ${titles}`);
  const preview = pages[previewIndex];
  const firstObservation = await bounded("Alpha click", visible.click("#increment"));
  console.error("Alpha click complete");
  if (!firstObservation.text.includes("1")) throw new Error("Adapter did not observe its own click");
  const count = await preview.$eval("#count", node => node.textContent);
  if (count !== "1") throw new Error(`CDP read incorrect count: ${count}`);
  const messageDeadline = Date.now() + 3_000;
  while (!output.includes("ALPHA_PREVIEW_COUNT=1") && Date.now() < messageDeadline) await Bun.sleep(50);
  if (!output.includes("ALPHA_PREVIEW_COUNT=1")) throw new Error("Visible WebContentsView did not observe CDP click");
  visible.takeOver();
  let blocked = false;
  try { await visible.click("#increment"); } catch { blocked = true; }
  if (!blocked) throw new Error("Alpha clicked while the user held the tab");
  await bounded("manual click", preview.click("#increment"));
  console.error("manual click complete");
  visible.returnControl();
  const afterUser = await bounded("reobserve", visible.observe());
  if (!afterUser.text.includes("2")) throw new Error("Alpha did not re-observe the user's change");
  console.log(JSON.stringify({ electron: "41.2.2", cdp: "ok", sameVisibleView: true, agentCount: count, afterUserCount: "2", takeoverBlocked: blocked }));
} finally {
  await visible?.disconnect();
  await browser?.disconnect();
  child.kill();
  await child.exited;
  await reader;
  await errorReader;
}
