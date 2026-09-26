import { createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
let exact: VisibleBrowser | undefined;
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
  const session = await preview.createCDPSession();
  const targetInfo = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
  await session.detach();
  exact = await bounded("exact target connect", VisibleBrowser.connect(cdpUrl, targetInfo.targetInfo.targetId, true));
  if ((await exact.observe()).title !== "alpha-preview-probe") throw new Error("Exact CDP target was not the visible preview");
  const firstObservation = await bounded("Alpha click", visible.click("#increment"));
  console.error("Alpha click complete");
  if (!firstObservation.text.includes("1")) {
    const diagnostic = await preview.evaluate(() => ({ count: document.querySelector("#count")?.textContent, focus: document.hasFocus(), viewport: [innerWidth, innerHeight] }));
    throw new Error(`Adapter did not observe its own click: ${JSON.stringify(diagnostic)}, text=${firstObservation.text.slice(0, 100)}`);
  }
  const count = await preview.$eval("#count", node => node.textContent);
  if (count !== "1") throw new Error(`CDP read incorrect count: ${count}`);
  const messageDeadline = Date.now() + 3_000;
  while (!output.includes("ALPHA_PREVIEW_COUNT=1") && Date.now() < messageDeadline) await Bun.sleep(50);
  if (!output.includes("ALPHA_PREVIEW_COUNT=1")) throw new Error("Visible WebContentsView did not observe CDP click");
  await bounded("Alpha fill", visible.fill("#query", "alpha"));
  await bounded("Alpha press", visible.press("#query", "Enter"));
  if (!(await bounded("Alpha wait", visible.wait("#submitted"))).text.includes("alpha")) throw new Error("Keyboard interaction did not reach the visible page");
  await bounded("Alpha scroll", visible.scroll(100));
  const transferRoot = await mkdtemp(join(tmpdir(), "alpha-browser-transfer-"));
  const uploadPath = join(transferRoot, "probe-upload.txt");
  await writeFile(uploadPath, "upload-content");
  if (!(await bounded("Alpha upload", visible.upload("#upload", uploadPath))).text.includes("probe-upload.txt")) throw new Error("File input did not receive the selected file");
  const download = await bounded("Alpha download", visible.download("#download", join(transferRoot, "downloads")), 20_000);
  if (download.bytes !== "download-content".length) throw new Error("Browser download content was not archived");
  const nested = await bounded("nested controls", visible.observe());
  const shadowRef = nested.controls.find(control => control.id === "shadow-button")?.ref;
  const frameRef = nested.controls.find(control => control.id === "frame-button")?.ref;
  if (!shadowRef || !frameRef) throw new Error("Open shadow or same-origin frame control was not observed");
  const afterShadow = await bounded("shadow click", visible.click(shadowRef));
  if (!afterShadow.text.includes("Shadow clicked")) throw new Error("Shadow control was not clicked");
  const freshFrameRef = afterShadow.controls.find(control => control.id === "frame-button")?.ref;
  if (!freshFrameRef || !(await bounded("frame click", visible.click(freshFrameRef))).text.includes("Frame clicked")) throw new Error("Frame control was not clicked");
  visible.takeOver();
  let blocked = false;
  try { await visible.click("#increment"); } catch { blocked = true; }
  if (!blocked) throw new Error("Alpha clicked while the user held the tab");
  const point = await preview.$eval("#increment", element => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
  await bounded("manual click", preview.mouse.click(point.x, point.y));
  console.error("manual click complete");
  visible.returnControl();
  const afterUser = await bounded("reobserve", visible.observe());
  if (!afterUser.text.includes("2")) throw new Error("Alpha did not re-observe the user's change");
  console.log(JSON.stringify({ electron: "41.2.2", cdp: "ok", exactTarget: true, sameVisibleView: true, agentCount: count, afterUserCount: "2", takeoverBlocked: blocked }));
} finally {
  await exact?.disconnect();
  await visible?.disconnect();
  await browser?.disconnect();
  child.kill();
  await child.exited;
  await reader;
  await errorReader;
}
