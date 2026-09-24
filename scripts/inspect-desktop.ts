import puppeteer from "puppeteer-core";
import { discoverBrowserWebSocket } from "../src/runtime/visible-browser";

const port = Bun.argv[2];
if (!port) throw new Error("Usage: bun run scripts/inspect-desktop.ts <cdp-port>");
const browser = await puppeteer.connect({ browserWSEndpoint: await discoverBrowserWebSocket(`http://127.0.0.1:${port}`), defaultViewport: null });
try {
  const pages = await browser.pages();
  for (const page of pages) {
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText.slice(-1500) ?? "");
    console.log(JSON.stringify({ title, url: page.url(), text }));
  }
} finally {
  await browser.disconnect();
}
