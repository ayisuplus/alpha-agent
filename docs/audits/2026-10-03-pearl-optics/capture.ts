/**
 * Pearl Optics UI evidence: drives the isolated preview from scripts/probe-workbench-ui.ts with headless Chrome,
 * saves screenshots, and records layout overflow, running-state hooks, reduced-motion behaviour and token contrast.
 *
 * Usage: bun run docs/audits/2026-10-03-pearl-optics/capture.ts <startup.json> <output dir>
 * Sends fixture prompts only to the loopback model started by the probe script.
 */
import puppeteer, { type Page } from "puppeteer-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [startupPath, outArg] = process.argv.slice(2);
if (!startupPath || !outArg) throw new Error("Usage: capture.ts <startup.json> <output dir>");
const out = resolve(outArg);
await mkdir(out, { recursive: true });
const { port, token } = JSON.parse(await readFile(startupPath, "utf8")) as { port: number; token: string };
const url = `http://127.0.0.1:${port}/ui/?token=${token}`;
const executablePath = process.env.ALPHA_CAPTURE_BROWSER ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({ executablePath, headless: true });
const page = await browser.newPage();
const report: Record<string, unknown> = { capturedAt: new Date().toISOString(), screenshots: [] as string[], overflow: {} as Record<string, unknown> };
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

async function load(theme: "light" | "dark", width: number, height: number, sidebarCollapsed = false) {
  await page.setViewport({ width, height });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".native-sidebar");
  // The app persists its own theme state after mount, so set the preference once it has settled and confirm it took.
  for (let attempt = 0; attempt < 3; attempt++) {
    await pause(600);
    await page.evaluate((theme, collapsed) => {
      localStorage.setItem("alpha-theme", theme);
      localStorage.setItem("alpha-native-sidebar-collapsed", String(collapsed));
    }, theme, sidebarCollapsed);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".native-sidebar");
    if (await page.evaluate(theme => document.documentElement.dataset.alphaTheme === theme, theme)) break;
  }
  await pause(900);
  // The workbench reopens the last session; captures start from a new conversation.
  if (!await page.$('[data-testid="brief"]')) { await page.click(".native-new"); await page.waitForSelector('[data-testid="brief"]'); }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}
async function shot(name: string) {
  await page.screenshot({ path: join(out, `${name}.png`) });
  (report.screenshots as string[]).push(`${name}.png`);
}
async function overflow(name: string) {
  (report.overflow as Record<string, unknown>)[name] = await page.evaluate(() => ({
    viewport: innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  }));
}
async function clickText(selector: string, text: string) {
  await page.evaluate((selector, text) => {
    const target = [...document.querySelectorAll<HTMLElement>(selector)].find(element => element.textContent?.includes(text));
    if (!target) throw new Error(`Missing ${selector} containing ${text}`);
    target.click();
  }, selector, text);
}
async function send(page: Page, text: string) {
  await page.waitForSelector('[data-testid="composer"]');
  await page.type('[data-testid="composer"]', text);
  await page.waitForSelector('.native-compose-toolbar > .native-primary:not(:disabled)');
  await page.click('.native-compose-toolbar > .native-primary');
}

report.fonts = await (async () => {
  await load("light", 1440, 900);
  return page.evaluate(() => ({
    segoeVariableText: document.fonts.check('16px "Segoe UI Variable Text"'),
    segoeVariableDisplay: document.fonts.check('16px "Segoe UI Variable Display"'),
  }));
})();

for (const theme of ["light", "dark"] as const) {
  await load(theme, 1440, 900);
  // Drafts persist per scope; replace any earlier draft so each capture shows one sentence.
  await page.click('[data-testid="brief"]');
  await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control");
  await page.keyboard.type("把这周的想法，整理成一份行动清单。");
  await shot(`home-${theme}`);
  await page.click('button[aria-label="命令面板"]');
  await page.waitForSelector(".native-modal");
  await pause(300);
  await shot(`palette-${theme}`);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".native-modal", { hidden: true });
  await page.click(".native-model-trigger");
  await pause(300);
  await shot(`model-menu-${theme}`);
  await page.keyboard.press("Escape");
  await clickText("button.native-session", "产品体验验证");
  await page.waitForSelector(".task-results", { timeout: 20_000 }).catch(async () => {
    // First run: produce the Word artifact through the fixture model.
    await send(page, "验证工具");
    await page.waitForSelector(".task-results", { timeout: 60_000 });
  });
  await pause(800);
  await shot(`thread-${theme}`);
  await page.evaluate(() => { const summary = document.querySelector<HTMLElement>(".native-tool-group > details > summary"); summary?.click(); });
  await pause(300);
  await shot(`tool-timeline-${theme}`);
  await page.click('button[aria-label="设置"]');
  await page.waitForSelector(".settings-nav");
  await pause(400);
  await shot(`settings-${theme}`);
}

// Running state: a long fixture stream keeps the session busy while the hooks are inspected.
await load("light", 1440, 900);
await clickText("button.native-session", "另一份草稿");
await send(page, "验证滚动");
await page.waitForSelector(".native-header[data-running]", { timeout: 30_000 });
await pause(1500);
await shot("running-light");
report.running = await page.evaluate(() => ({
  headerRunning: !!document.querySelector(".native-header[data-running]"),
  composerStreaming: !!document.querySelector(".native-compose[data-streaming]"),
  animations: [...new Set(document.getAnimations().map(animation => (animation as CSSAnimation).animationName))].sort(),
}));
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await pause(300);
report.reducedMotion = await page.evaluate(() => ({
  runningAnimations: document.getAnimations().filter(animation => animation.playState === "running").length,
  headerScanBackgroundSize: getComputedStyle(document.querySelector(".native-header")!, "::after").backgroundSize,
}));
await shot("running-reduced-motion-light");
await page.emulateMediaFeatures([]);
await page.click('button[aria-label="停止生成"]').catch(() => undefined);
await pause(1500);

// Layout at the widths the workbench supports.
for (const [width, height] of [[1440, 900], [1280, 800], [1101, 800], [1024, 768], [720, 800], [400, 720]] as const) {
  await load("light", width, height, width <= 760);
  await overflow(`home-${width}x${height}`);
  await clickText("button.native-session", "产品体验验证").catch(() => undefined);
  await pause(1200);
  if (width === 1101) {
    await page.click('button[aria-label="打开文件栏"]').catch(() => undefined);
    await pause(600);
    await shot("drawer-1101x800");
  }
  await overflow(`thread-${width}x${height}`);
  if (width === 720 || width === 400) await shot(`thread-${width}x${height}`);
}

await writeFile(join(out, "capture.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
