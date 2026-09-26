import { createServer } from "node:net";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { TaskLedger } from "../src/runtime/task-ledger";
import { discoverBrowserWebSocket, VisibleBrowser } from "../src/runtime/visible-browser";

const workspace = await mkdtemp(join(tmpdir(), "alpha-web-desktop-"));
const project = join(workspace, "products", "probe");
await mkdir(project, { recursive: true });
const ledger = await TaskLedger.create(join(workspace, ".alpha"), { objective: "Verify desktop browser bridge", projectRoot: project, taskType: "research", criteria: [{ id: "web", description: "Open a public page", kind: "source" }] });
const portServer = createServer();
await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
const address = portServer.address();
if (!address || typeof address === "string") throw new Error("No CDP port");
await new Promise<void>(resolve => portServer.close(() => resolve()));

const env: NodeJS.ProcessEnv = { ...process.env, ALPHA_WORKSPACE_ROOT: workspace, ALPHA_CDP_PORT: String(address.port), ALPHA_BUN_PATH: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const child = Bun.spawn([join(process.cwd(), "node_modules", "electron", "dist", "electron.exe"), join(process.cwd(), "desktop", "main.cjs")], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;
let previewServer: ReturnType<typeof Bun.serve> | null = null;
let output = "";
let errors = "";
const readOutput = (async () => { for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk); })();
const readErrors = (async () => { for await (const chunk of child.stderr) errors = (errors + new TextDecoder().decode(chunk)).slice(-4000); })();
try {
  const deadline = Date.now() + 40_000;
  let serverPort = 0;
  while (Date.now() < deadline) {
    serverPort = Number(/ALPHA_DESKTOP_READY (\d+)/.exec(output)?.[1] ?? 0);
    if (serverPort) break;
    if (child.exitCode !== null) throw new Error(`Electron exited: ${output}\n${errors}`);
    await Bun.sleep(100);
  }
  if (!serverPort) throw new Error(`Desktop did not start: ${output}\n${errors}`);
  const origin = `http://127.0.0.1:${serverPort}`;
  const providers = await (await fetch(`${origin}/api/web/providers`)).json() as { desktopBrowser: boolean; providers: unknown[] };
  if (!providers.desktopBrowser || providers.providers.length !== 2) throw new Error("Web provider route is unavailable");
  const keyRoute = `${origin}/api/web/providers/tavily/key`;
  const saved = await fetch(keyRoute, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "probe-not-a-real-key" }) });
  if (!saved.ok) throw new Error(`Encrypted provider key store failed: ${await saved.text()}`);
  const configured = await (await fetch(`${origin}/api/web/providers`)).json() as { providers: Array<{ id: string; configured: boolean }> };
  if (!configured.providers.find(provider => provider.id === "tavily")?.configured) throw new Error("Saved provider key was not available to the sidecar");
  if (!(await fetch(keyRoute, { method: "DELETE" })).ok) throw new Error("Could not remove probe provider key");
  const response = await fetch(`${origin}/api/tasks/${ledger.state.id}/web-tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://github.com" }), signal: AbortSignal.timeout(35_000) });
  const opened = await response.json() as { tab?: { tabId: string; targetId: string; url: string }; error?: string };
  if (!response.ok || !opened.tab?.targetId || !opened.tab.url.startsWith("https://github.com")) throw new Error(`Could not open owned GitHub tab: ${JSON.stringify(opened)}\n${errors}`);
  const tabs = await (await fetch(`${origin}/api/tasks/${ledger.state.id}/web-tabs`)).json() as { tabs: Array<{ tabId: string; targetId: string }> };
  if (!tabs.tabs.some(tab => tab.tabId === opened.tab!.tabId && tab.targetId === opened.tab!.targetId)) throw new Error("Owned tab identity changed");
  browser = await puppeteer.connect({ browserWSEndpoint: await discoverBrowserWebSocket(`http://127.0.0.1:${address.port}`), defaultViewport: null });
  const pages = await browser.pages();
  const shell = (await Promise.all(pages.map(async page => ({ page, title: await page.title() })))).find(item => item.title === "Alpha 工作台")?.page;
  if (!shell) throw new Error("Workbench view is missing");
  await shell.waitForSelector('.web-native-slot', { timeout: 10_000 });
  await shell.waitForSelector('.browser-page.active button', { timeout: 10_000 });
  const layout = await shell.evaluate(() => ({
    selected: document.querySelector('.workspace-tabs [aria-selected="true"]')?.textContent,
    slot: document.querySelector('.web-native-slot')?.getBoundingClientRect().toJSON(),
    tab: document.querySelector('.browser-page.active button')?.textContent,
  }));
  if (layout.selected !== "浏览器" || !layout.tab || !layout.slot || layout.slot.width < 300 || layout.slot.height < 200) throw new Error(`Public page is not in the right panel: ${JSON.stringify(layout)}`);
  const publicPage = (await browser.pages()).find(page => page.url().startsWith("https://github.com/"));
  if (!publicPage) throw new Error("Embedded page is not available to the browser driver");
  await publicPage.waitForFunction(() => (document.body?.innerText.length ?? 0) > 30, { timeout: 20_000, polling: 100 });
  const viewport = await publicPage.evaluate(() => ({ width: innerWidth, height: innerHeight, textLength: document.body?.innerText.length ?? 0 }));
  if (viewport.textLength < 30) throw new Error(`Embedded public page did not render useful content: ${JSON.stringify(viewport)}`);
  if (Math.abs(viewport.width - layout.slot.width) > 3 || Math.abs(viewport.height - layout.slot.height) > 3) throw new Error(`Agent viewport differs from visible panel: ${JSON.stringify({ viewport, slot: layout.slot })}`);
  await shell.click('.browser-pages > button');
  await shell.waitForSelector('.preview-slot');
  if (publicPage.isClosed()) throw new Error("Switching to the product preview destroyed the public browser tab");
  await shell.click('.browser-page button');
  await shell.waitForSelector('.web-native-slot');
  if (publicPage.url() !== opened.tab.url) throw new Error("Switching browser pages changed the agent's target");
  const close = await fetch(`${origin}/api/tasks/${ledger.state.id}/web-tabs/${opened.tab.tabId}/close`, { method: "POST" });
  if (!close.ok) throw new Error(`Could not close owned tab: ${await close.text()}`);
  await shell.waitForFunction(() => !document.querySelector('.web-native-slot'));
  const closeDeadline = Date.now() + 3_000;
  while ((await browser.pages()).some(page => page.url().startsWith("https://github.com/")) && Date.now() < closeDeadline) await Bun.sleep(100);
  if ((await browser.pages()).some(page => page.url().startsWith("https://github.com/"))) throw new Error("Closed public page still has a browser target");
  previewServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<title>Native preview probe</title><button id="increment" onclick="document.querySelector(\'#count\').textContent=\'1\'">Increment</button><strong id="count">0</strong>', { headers: { "content-type": "text/html" } }) });
  const previewUrl = `http://127.0.0.1:${previewServer.port}/`;
  await shell.waitForSelector('.preview-slot');
  await shell.evaluate(url => {
    const element = document.querySelector('.preview-slot')!;
    const rect = element.getBoundingClientRect();
    const root = element.closest('.workbench')!.getBoundingClientRect();
    const factor = innerWidth / root.width;
    window.alpha?.loadPreview(url);
    window.alpha?.setPreviewBounds?.({ x: rect.left * factor, y: rect.top * factor, width: rect.width * factor, height: rect.height * factor, visible: true });
  }, previewUrl);
  let previewPage: Awaited<ReturnType<typeof browser.pages>>[number] | undefined;
  const previewDeadline = Date.now() + 10_000;
  while (Date.now() < previewDeadline) {
    previewPage = (await browser.pages()).find(page => page.url() === previewUrl);
    if (previewPage) break;
    await Bun.sleep(100);
  }
  if (!previewPage) throw new Error("Native product preview did not load");
  await previewPage.waitForFunction(() => innerWidth > 300 && innerHeight > 200, { timeout: 5_000, polling: 100 });
  const session = await previewPage.createCDPSession();
  const info = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
  await session.detach();
  const visible = await VisibleBrowser.connect(`http://127.0.0.1:${address.port}`, info.targetInfo.targetId, true);
  try {
    let observed;
    try { observed = await visible.click("#increment"); }
    catch (error) {
      const geometry = await previewPage.evaluate(() => {
        const button = document.querySelector("#increment")!;
        const rect = button.getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, rect: rect.toJSON(), hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.outerHTML.slice(0, 200) };
      });
      throw new Error(`Native preview click failed: ${String(error)} ${JSON.stringify(geometry)}`);
    }
    if (!observed.text.includes("1") || await previewPage.$eval("#count", node => node.textContent) !== "1") throw new Error("Agent click did not reach the native product preview");
  } finally { await visible.disconnect(); }
  console.log(JSON.stringify({ ready: true, desktopBrowser: true, exactTarget: true, embeddedPanel: true, sharedPreview: true, viewport, github: opened.tab.url, workspace }));
} finally {
  previewServer?.stop(true);
  if (browser) await browser.disconnect().catch(() => undefined);
  child.kill();
  await child.exited;
  await readOutput;
  await readErrors;
}
