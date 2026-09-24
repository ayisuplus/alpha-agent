import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { discoverBrowserWebSocket } from "../src/runtime/visible-browser";

const port = Bun.argv[2];
if (!port) throw new Error("Usage: bun run probe:desktop <cdp-port>");
const endpoint = await discoverBrowserWebSocket(`http://127.0.0.1:${port}`);
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
try {
  const pages = await browser.pages();
  const entries = await Promise.all(pages.map(async page => ({ page, title: await page.title(), url: page.url() })));
  const shell = entries.find(item => item.title === "Alpha 工作台");
  const preview = entries.find(item => item !== shell && (item.title === "Alpha preview" || /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url)));
  if (!shell || !preview) throw new Error(`Desktop views missing: ${JSON.stringify(entries.map(({ title, url }) => ({ title, url })))}`);
  const text = await shell.page.$eval("body", node => node.innerText);
  const regions = await shell.page.evaluate(() => ["workbench", "thread", "preview-slot"].every(id => document.querySelector(`[data-testid="${id}"]`))
    && !!document.querySelector('[data-testid="timeline"], [data-testid="new-task"]'));
  if (!text.includes("新建任务") || !regions) throw new Error(`Shell content missing: ${text.slice(0, 300)}`);
  const screenshotPath = join(process.cwd(), ".alpha", "screenshots", "desktop-smoke.png");
  await mkdir(join(process.cwd(), ".alpha", "screenshots"), { recursive: true });
  await writeFile(screenshotPath, await shell.page.screenshot({ type: "png" }));
  console.log(JSON.stringify({ shell: shell.url, preview: preview.url, screenshotPath, ready: true }));
} finally {
  await browser.disconnect();
}
