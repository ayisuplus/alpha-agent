import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { ProjectStore } from "../src/runtime/projects";
import { TaskLedger } from "../src/runtime/task-ledger";
import { discoverBrowserWebSocket } from "../src/runtime/visible-browser";

const appRoot = resolve(import.meta.dir, "..");
const workspace = await mkdtemp(join(tmpdir(), "alpha-ui-refresh-"));
const output = resolve(Bun.argv[2] ?? join(tmpdir(), "alpha-ui-refresh-screenshots"));
const dataRoot = join(workspace, ".alpha");
const projectRoot = join(workspace, "products", "probe");
await mkdir(dataRoot, { recursive: true });
await mkdir(projectRoot, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(join(projectRoot, "index.html"), "<h1>Probe</h1>");
const project = await new ProjectStore(dataRoot).create("工作项目");
const task = await TaskLedger.create(dataRoot, {
  objective: "检查工作项目的界面布局",
  projectRoot,
  projectId: project.id,
  projectVersion: project.version,
  taskType: "research",
  startMode: "plan",
  criteria: [{ id: "layout", description: "界面布局", kind: "source" }, { id: "build", description: "构建", kind: "build" }],
});
await mkdir(join(dataRoot, "evidence"), { recursive: true });
const buildLog = join(dataRoot, "evidence", "build.log");
await writeFile(buildLog, "probe build passed");
await task.recordEvidence({ criterionId: "build", kind: "build", passed: true, source: buildLog, revision: task.state.revision! });
await task.reviseCognition({ summary: "先检查界面布局", reason: "探针计划", candidates: [], nodes: [{ id: "inspect", objective: "检查当前界面", kind: "investigate", phase: "investigate", dependsOn: [], expertDecision: { reason: "探针自行调查" }, host: "coordinator", skillIds: [], status: "planned" }, { id: "work", objective: "完成界面调整", kind: "execute", phase: "execute", dependsOn: ["inspect"], expertDecision: { reason: "探针自行执行" }, host: "coordinator", skillIds: [], status: "planned" }, { id: "review", objective: "检查调整", kind: "review", phase: "review", dependsOn: ["work"], expertDecision: { reason: "探针自行检查" }, host: "coordinator", skillIds: [], status: "planned" }] });
await task.submitPlanForReview();
const socket = createServer();
await new Promise<void>(resolveReady => socket.listen(0, "127.0.0.1", resolveReady));
const address = socket.address();
if (!address || typeof address === "string") throw new Error("Cannot allocate CDP port");
await new Promise<void>(resolveReady => socket.close(() => resolveReady()));
const env: NodeJS.ProcessEnv = { ...process.env, ALPHA_WORKSPACE_ROOT: workspace, ALPHA_CDP_PORT: String(address.port), ALPHA_BUN_PATH: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const electron = Bun.spawn([join(appRoot, "node_modules", "electron", "dist", "electron.exe"), join(appRoot, "desktop", "main.cjs")], {
  cwd: appRoot, env, stdout: "pipe", stderr: "pipe",
});
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
const stderr = new Response(electron.stderr).text();
try {
  const reader = electron.stdout.getReader();
  const ready = (async () => {
    let outputText = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Desktop exited: ${outputText}`);
      outputText += new TextDecoder().decode(chunk.value);
      if (/ALPHA_DESKTOP_READY \d+ \d+/.test(outputText)) return;
    }
  })();
  await Promise.race([ready, Bun.sleep(25_000).then(() => { throw new Error("Desktop startup timed out"); })]);
  browser = await puppeteer.connect({ browserWSEndpoint: await discoverBrowserWebSocket(`http://127.0.0.1:${address.port}`), defaultViewport: null });
  const pages = await browser.pages();
  const shell = (await Promise.all(pages.map(async page => ({ page, title: await page.title() })))).find(item => item.title === "Alpha 工作台")?.page;
  if (!shell) throw new Error("Workbench view is missing");
  await shell.waitForSelector(`.project-group .task-row[title="${task.state.objective}"]`);
  await shell.waitForSelector(".thread-title-row h1");
  await shell.waitForSelector('[aria-label="待审计划步骤"] li');
  const planActions = await shell.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.composer-bar button')].map(button => button.textContent?.trim()));
  if (!planActions.includes("开始执行") || !planActions.includes("继续规划")) throw new Error(`Plan review actions missing: ${JSON.stringify(planActions)}`);
  const initial = await shell.evaluate(() => ({
    grid: getComputedStyle(document.querySelector(".workbench")!).gridTemplateColumns.split(" ").length,
    hasPreview: !!document.querySelector(".preview-slot"),
    review: document.querySelector('.workspace-tabs [role="tab"][aria-selected="true"]')?.textContent,
    bg: getComputedStyle(document.documentElement).getPropertyValue("--bg-app").trim(),
    project: document.querySelector(".project-toggle")?.textContent,
  }));
  if (initial.grid !== 4 || initial.hasPreview || initial.review !== "审查" || initial.bg !== "#faf9f6" || !initial.project?.includes("工作项目")) throw new Error(`Initial layout: ${JSON.stringify(initial)}`);
  await shell.screenshot({ path: join(output, "task.png") });

  await shell.click('.workspace-tabs [role="tab"]:nth-child(2)');
  await shell.waitForSelector('.terminal-pane');
  await shell.waitForFunction(() => document.querySelector('.terminal-output')?.textContent?.includes('probe build passed'));
  const terminal = await shell.$eval('.terminal-note', element => element.textContent);
  if (!terminal?.includes('不接受交互式命令')) throw new Error(`Terminal did not disclose read-only state: ${terminal}`);
  await shell.screenshot({ path: join(output, "terminal.png") });
  await shell.click('.workspace-tabs [role="tab"]:nth-child(3)');
  await shell.waitForSelector(".preview-slot");
  await shell.screenshot({ path: join(output, "preview.png") });
  await shell.click('[aria-label="收起右侧栏"]');
  await shell.waitForFunction(() => !document.querySelector(".preview-slot"));
  await shell.waitForSelector('.workspace-rail [aria-label="打开审查栏"]');

  await shell.click('[aria-label="任务详情"]');
  await shell.waitForSelector('.workspace-panel .criteria-row .criterion');
  await shell.screenshot({ path: join(output, "info.png") });
  await shell.click('.workspace-panel .criteria-row .criterion');
  await shell.waitForSelector('.workspace-panel [data-testid="evidence-view"]');
  const review = await shell.evaluate(() => ({ timeline: !!document.querySelector('[data-testid="timeline"]'), composer: !!document.querySelector('[data-testid="composer-input"]') }));
  if (!review.timeline || !review.composer) throw new Error(`Review displaced conversation: ${JSON.stringify(review)}`);
  await shell.screenshot({ path: join(output, "evidence.png") });
  await shell.click('.workspace-panel .detail-header button');
  await shell.waitForSelector('.review-home');
  await shell.click('[aria-label="收起右侧栏"]');
  await shell.waitForSelector('.workspace-rail');

  await shell.click('.new-task-button');
  await shell.waitForSelector('#brief');
  const newTaskRail = await shell.evaluate(() => ({
    grid: getComputedStyle(document.querySelector(".workbench")!).gridTemplateColumns.split(" ").length,
    items: [...document.querySelectorAll('.workspace-rail button')].map(item => item.textContent),
  }));
  if (newTaskRail.grid !== 3 || newTaskRail.items.join(',') !== '审查,终端,浏览器') throw new Error(`New task rail: ${JSON.stringify(newTaskRail)}`);
  await shell.screenshot({ path: join(output, "new-task-simple.png") });
  await shell.click(`[aria-label="在「工作项目」中新建任务"]`);
  await shell.waitForSelector('#brief');
  await shell.waitForSelector('.new-task-setup');
  await shell.select('.new-task-setup .setup-field select', 'plan');
  await shell.click('.setup-continuation input[type="checkbox"]');
  await shell.waitForFunction(() => document.querySelector('[data-testid="start-build"]')?.textContent === '开始规划');
  if (!await shell.$eval('.setup-continuation input', element => (element as HTMLInputElement).checked)) throw new Error("Continuation toggle did not update");
  const selected = await shell.$eval('.new-task-setup .setup-fields select', element => (element as HTMLSelectElement).value);
  if (selected !== project.id) throw new Error(`Project preselection failed: ${selected}`);
  if (await shell.$('.new-task .new-task-type-list')) throw new Error("Task controls remained in the conversation pane");
  await shell.click('.new-task-type-list button:nth-child(4)');
  await shell.waitForFunction(() => document.querySelector('.new-task-hero h1')?.textContent === '想研究什么？');
  await shell.click('.new-task-type-list button:nth-child(3)');
  await shell.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.setup-link')].find(button => button.textContent?.includes('挂载本机文件夹'))?.click());
  await shell.waitForSelector('[aria-label="要挂载的本机文件夹"]');
  await shell.type('[aria-label="要挂载的本机文件夹"]', projectRoot);
  await shell.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.setup-inline button')].find(button => button.textContent === '挂载')?.click());
  await shell.waitForFunction(path => document.querySelector('.new-task-context')?.textContent?.includes(path), {}, projectRoot);
  await shell.select('.setup-fields label:last-of-type select', 'auto');
  await shell.waitForFunction(() => document.querySelector('.new-task-context')?.textContent?.includes('帮我批准'));
  await shell.screenshot({ path: join(output, "new-task.png") });
  await shell.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.setup-link')].find(button => button.textContent?.includes('新建项目'))?.click());
  await shell.type('[aria-label="新项目名称"]', '第二项目');
  await shell.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('.setup-inline button')].find(button => button.textContent === '创建')?.click());
  await shell.waitForFunction(() => document.querySelector('.new-task-context')?.textContent?.includes('第二项目'));
  await shell.select('.setup-fields select', project.id);
  await shell.click('.new-task-type-list button:nth-child(2)');
  await shell.waitForSelector('[aria-label="要导入的项目绝对路径"]');
  await shell.type('[aria-label="要导入的项目绝对路径"]', projectRoot);
  await shell.waitForFunction(path => document.querySelector('.new-task-context')?.textContent?.includes(path), {}, projectRoot);
  await shell.click('.new-task-type-list button:nth-child(3)');
  const viewports: Array<[number, number]> = [[1080, 720], [1440, 900], [1920, 1080]];
  for (const [width, height] of viewports) {
    await shell.setViewport({ width, height });
    const geometry = await shell.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>("#brief")?.getBoundingClientRect();
      return { viewport: innerWidth, inputLeft: input?.left, inputRight: input?.right };
    });
    if (!geometry.inputLeft || !geometry.inputRight || geometry.inputLeft < 0 || geometry.inputRight > geometry.viewport) {
      throw new Error(`New task overflows at ${width}×${height}: ${JSON.stringify(geometry)}`);
    }
  }
  await shell.setViewport({ width: 1080, height: 720 });
  for (const zoom of [1.1, 1.2, 1.35, 1.5]) {
    await shell.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Equal", ctrlKey: true, bubbles: true })));
    await shell.waitForFunction(expected => document.querySelector<HTMLElement>(".workbench")?.style.zoom === String(expected), {}, zoom);
  }
  await shell.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyB", ctrlKey: true, shiftKey: true, bubbles: true })));
  await shell.waitForSelector(".preview-slot");
  const zoomed = await shell.evaluate(() => {
    const children = [...document.querySelector(".new-task-box .composer-bar")!.children].map(element => element.getBoundingClientRect());
    const overlap = children.some((a, index) => children.slice(index + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
    return { thread: parseFloat(getComputedStyle(document.querySelector(".thread")!).width), preview: parseFloat(getComputedStyle(document.querySelector(".preview-slot")!).width), overlap };
  });
  if (zoomed.thread < 318 || zoomed.preview < 318 || zoomed.overlap) throw new Error(`Zoomed layout is cramped: ${JSON.stringify(zoomed)}`);
  await shell.screenshot({ path: join(output, "zoomed.png") });
  console.log(JSON.stringify({ ok: true, screenshots: output, initial, review, terminal, newTaskRail, projectSelected: true, sidebarMount: true, sidebarProjectCreate: true, sidebarImport: true, viewports, zoomed }));
} finally {
  if (browser) await browser.disconnect().catch(() => undefined);
  electron.kill();
  await Promise.race([electron.exited, Bun.sleep(5_000)]);
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  const errorText = await stderr;
  if (errorText && !browser) console.error(errorText.slice(-3000));
}
