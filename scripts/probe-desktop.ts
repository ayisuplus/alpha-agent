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
  const regions = await shell.page.evaluate(() => !!document.querySelector(".native-workbench .native-sidebar") && !!document.querySelector(".native-workspace"));
  if (!text.includes("新会话") || !regions) throw new Error(`Native workbench content missing: ${text.slice(0, 300)}`);
  const home = await shell.page.evaluate(() => !!document.querySelector(".native-home .halftone") && !!document.querySelector(".native-settings-entry") && !!document.querySelector(".native-home .native-model-picker"));
  if (!home) throw new Error("Desktop welcome page, model picker or settings entry is missing");
  console.log(JSON.stringify({ shell: shell.url, preview: preview.url, nativeWorkbench: true, welcome: true, settingsEntry: true, ready: true }));
} finally {
  await browser.disconnect();
}
