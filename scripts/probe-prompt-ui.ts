import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const url = Bun.argv[2];
if (!url) throw new Error("Usage: bun scripts/probe-prompt-ui.ts <workbench-url>");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(url, { waitUntil: "networkidle2" });
  if (!await page.$("#brief")) {
    const switched = await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes("新建任务"));
      button?.click();
      return !!button;
    });
    if (!switched) throw new Error(`Cannot open new task: ${(await page.$eval("body", element => element.textContent ?? "")).slice(0, 500)}`);
  }
  await page.waitForSelector("#brief");
  const picker = await page.$('button[title^="这个任务的模型"]');
  if (!picker) throw new Error("Task model picker is missing");
  await picker.click();
  await page.waitForSelector(".model-search input");
  await page.type(".model-search input", "deepseek-flash");
  const option = await page.$(".model-option");
  if (!option) throw new Error("DeepSeek Flash is unavailable in the model picker");
  await option.click();

  const source = "做一个记账本，只要 2 个页面，375px 手机能用，不要登录。";
  await page.type("#brief", source);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent?.includes("优化并英译") && !button.disabled));
  await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("优化并英译"))?.click());
  await page.waitForSelector('[role="dialog"][aria-label="提示词优化结果"]', { timeout: 120_000 });
  const before = await page.$eval("#brief", element => (element as HTMLTextAreaElement).value);
  const dialogText = await page.$eval('[role="dialog"][aria-label="提示词优化结果"]', element => element.textContent ?? "");
  if (before !== source || !dialogText.includes("软件开发") || !dialogText.includes("375px") || !dialogText.includes("英文版")) {
    throw new Error(`Prompt review is incomplete: ${JSON.stringify({ before, dialogText: dialogText.slice(0, 500) })}`);
  }
  const screenshots = resolve(".alpha", "screenshots");
  await mkdir(screenshots, { recursive: true });
  const screenshot = join(screenshots, "prompt-refinement-review.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  const narrowBounds = await page.$eval('[role="dialog"][aria-label="提示词优化结果"]', element => element.getBoundingClientRect().toJSON() as { left: number; right: number });
  if (narrowBounds.left < 0 || narrowBounds.right > 390) throw new Error(`Prompt review overflows narrow viewport: ${JSON.stringify(narrowBounds)}`);
  const narrowScreenshot = join(screenshots, "prompt-refinement-review-narrow.png");
  await page.screenshot({ path: narrowScreenshot });
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent?.includes("使用英文版"))?.click());
  const after = await page.$eval("#brief", element => (element as HTMLTextAreaElement).value);
  if (after === source || !after.includes("375px") || await page.$('[role="dialog"][aria-label="提示词优化结果"]')) {
    throw new Error(`Applying English did not update only the draft: ${after}`);
  }
  console.log(JSON.stringify({ originalPreservedUntilApply: true, englishApplied: true, screenshot, narrowScreenshot, after }));
} finally { await browser.close(); }
