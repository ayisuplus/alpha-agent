import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { TaskLedger } from "../src/runtime/task-ledger";
import { AgentMailbox, createWorkerMailboxTools } from "../src/runtime/agent-mailbox";
import type { WorkOrder } from "../src/runtime/work-orders";
import { verifyGeneralDeliverable } from "../src/runtime/general-work";
import { discoverBrowserWebSocket } from "../src/runtime/visible-browser";

const appRoot = resolve(import.meta.dir, "..");
const workspace = await mkdtemp(join(tmpdir(), "alpha-general-ui-"));
const output = resolve(Bun.argv[2] ?? join(workspace, "screenshots"));
const dataRoot = join(workspace, ".alpha");
const productsRoot = join(workspace, "products");
await mkdir(output, { recursive: true });
await mkdir(productsRoot, { recursive: true });

const waitingRoot = join(productsRoot, "waiting");
await mkdir(waitingRoot);
const waiting = await TaskLedger.create(dataRoot, { objective: "等待用户回答", projectRoot: waitingRoot, taskType: "general", criteria: [] });
const agentId = crypto.randomUUID();
const attemptId = crypto.randomUUID();
const order: WorkOrder = { id: "inspect", objective: "检查中断现场", acceptance: ["保留可审阅的中断信息"], mode: "investigate", ownedPaths: [], readPaths: ["."], resources: [], agentId, instanceId: attemptId, fullAccess: true };
await waiting.queueWorker({ id: attemptId, order });
await waiting.updateWorker(attemptId, "failed");
const [send] = createWorkerMailboxTools(join(dataRoot, "worker-agents", waiting.state.id, agentId, "state"), waiting.state.id, order);
const sent = await send.execute("probe-message", { kind: "information", body: "中断现场已保留" }, undefined, undefined as never);
if (sent.isError) throw new Error("Cannot create neutral-agent message fixture");
await new AgentMailbox(dataRoot, waiting).collect();
await waiting.recordCheckpointFailure("项目状态恢复待审阅：保留现有改动");
await waiting.needInput("请补充目标", "question");

const planRoot = join(productsRoot, "plan");
await mkdir(planRoot);
const plan = await TaskLedger.create(dataRoot, { objective: "规划一个任务", projectRoot: planRoot, taskType: "general", startMode: "plan", criteria: [] });
await plan.reviseCognition({ summary: "先检查需求", reason: "probe", candidates: [], steps: [{ id: "inspect", objective: "审阅需求", mode: "investigate", dependsOn: [], skillIds: [], status: "planned" }] });
await plan.submitPlanForReview();

const resultRoot = join(productsRoot, "result");
await mkdir(join(resultRoot, "outputs"), { recursive: true });
const result = await TaskLedger.create(dataRoot, { objective: "交付示例成果", projectRoot: resultRoot, taskType: "file-work", criteria: [{ id: "deliverable", description: "交付文件", kind: "artifact" }] });
await writeFile(join(resultRoot, "outputs", "result.txt"), "verified output");
await writeFile(join(resultRoot, "alpha-deliverable.json"), JSON.stringify({ outputs: [{ path: "outputs/result.txt" }] }));
await result.refreshRevision();
await verifyGeneralDeliverable(result, dataRoot);

const socket = createServer();
await new Promise<void>(resolveReady => socket.listen(0, "127.0.0.1", resolveReady));
const address = socket.address();
if (!address || typeof address === "string") throw new Error("Cannot allocate CDP port");
await new Promise<void>(resolveReady => socket.close(() => resolveReady()));
const env: NodeJS.ProcessEnv = { ...process.env, ALPHA_WORKSPACE_ROOT: workspace, ALPHA_CDP_PORT: String(address.port), ALPHA_BUN_PATH: process.execPath };
delete env.ELECTRON_RUN_AS_NODE;
const electron = Bun.spawn([join(appRoot, "node_modules", "electron", "dist", "electron.exe"), join(appRoot, "desktop", "main.cjs")], { cwd: appRoot, env, stdout: "pipe", stderr: "pipe" });
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
try {
  const reader = electron.stdout.getReader();
  const ready = (async () => { let text = ""; while (true) { const chunk = await reader.read(); if (chunk.done) throw new Error(`Desktop exited: ${text}`); text += new TextDecoder().decode(chunk.value); if (/ALPHA_DESKTOP_READY \d+ \d+/.test(text)) return; } })();
  await Promise.race([ready, Bun.sleep(25_000).then(() => { throw new Error("Desktop startup timed out"); })]);
  browser = await puppeteer.connect({ browserWSEndpoint: await discoverBrowserWebSocket(`http://127.0.0.1:${address.port}`), defaultViewport: null });
  const shell = (await Promise.all((await browser.pages()).map(async page => ({ page, title: await page.title() })))).find(item => item.title === "Alpha 工作台")?.page;
  if (!shell) throw new Error("Workbench page is missing");
  await shell.setViewport({ width: 1080, height: 720 });
  const expandSidebar = async () => {
    await shell.waitForFunction(() => !document.querySelector(".thread-loading") && !!document.querySelector(".sidebar"));
    if (await shell.$(".sidebar.collapsed")) await shell.click('[aria-label="展开任务栏 (Ctrl+B)"]');
    await shell.waitForSelector(".new-task-button");
  };
  await expandSidebar();
  console.log("probe: new task");
  await shell.click(".new-task-button");
  await shell.waitForSelector("#brief");
  const initial = await shell.evaluate(() => ({
    heading: document.querySelector(".new-task-hero h1")?.getAttribute("aria-label"),
    projectPanel: !!document.querySelector('[aria-label="项目与工作目录"]'),
    refine: [...document.querySelectorAll(".new-task-box button")].some(button => button.textContent?.includes("优化并英译")),
    taskTypes: !!document.querySelector(".new-task-type-list"),
  }));
  if (initial.heading !== "你好，我是 Alpha，想让我替你完成什么？" || !initial.projectPanel || !initial.refine || initial.taskTypes) throw new Error(`Unified composer failed: ${JSON.stringify(initial)}`);
  await shell.click('[aria-label="添加文件、Skill 或插件"]');
  console.log("probe: plus menu");
  const menu = await shell.$eval(".capability-menu", element => element.textContent);
  if (!menu?.includes("添加文件") || !menu.includes("添加 Skill") || !menu.includes("添加插件") || menu.includes("文件夹")) throw new Error(`Plus menu failed: ${menu}`);
  await shell.click('[aria-label="关闭添加菜单"]');
  const input = await shell.$('input[aria-label="添加任务文件"]');
  if (!input) throw new Error("File input missing");
  const sample = join(workspace, "sample.txt");
  await writeFile(sample, "draft attachment");
  await input.uploadFile(sample);
  await shell.waitForFunction(() => document.querySelector(".capability-tag")?.textContent?.includes("sample.txt"));
  await shell.reload();
  console.log("probe: reload");
  await expandSidebar();
  await shell.click(".new-task-button");
  await shell.waitForFunction(() => document.querySelector(".capability-tag")?.textContent?.includes("sample.txt"));
  await shell.screenshot({ path: join(output, "new-task-1080.png") });
  await shell.click('[aria-label="移除文件 sample.txt"]');
  await shell.waitForFunction(() => !document.querySelector(".capability-tag"));

  const taskRow = (objective: string) => `.task-row[title="${objective}"]`;
  console.log("probe: plan row");
  await shell.click(taskRow(plan.state.objective));
  await shell.waitForSelector('.composer[data-mode="plan-review"] [data-testid="composer-input"]');
  const planInput = await shell.$eval('[data-testid="composer-input"]', element => !(element as HTMLTextAreaElement).disabled);
  if (!planInput) throw new Error("Plan feedback is disabled");
  await shell.type('[data-testid="composer-input"]', "请调整计划范围");
  const feedback = await shell.$eval('.composer-bar', element => [...element.querySelectorAll('button')].map(button => button.textContent).find(value => value?.includes("重新规划")));
  if (!feedback?.includes("重新规划")) throw new Error(`Plan feedback action missing: ${feedback}`);
  await shell.screenshot({ path: join(output, "plan-feedback.png") });

  await shell.click(taskRow(waiting.state.objective));
  console.log("probe: waiting row");
  await shell.waitForSelector('.composer[data-mode="resume"] [data-testid="composer-input"]');
  await shell.focus('[data-testid="composer-input"]');
  await shell.keyboard.down("Control"); await shell.keyboard.press("Enter"); await shell.keyboard.up("Control");
  const waitingState = await shell.evaluate(() => ({ disabled: (document.querySelector('.composer-bar .btn-primary') as HTMLButtonElement)?.disabled, value: (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement)?.value }));
  if (!waitingState.disabled || waitingState.value) throw new Error(`Blank shortcut bypassed submit guard: ${JSON.stringify(waitingState)}`);
  await shell.click('[aria-label="任务详情"]');
  await shell.waitForSelector(".task-info-view");
  await shell.evaluate(() => document.querySelectorAll<HTMLDetailsElement>(".task-info-view .cognition-panel").forEach(panel => { panel.open = true; }));
  await shell.waitForFunction(() => document.body.innerText.includes("通用执行") && document.body.innerText.includes("中断现场已保留") && document.body.innerText.includes("项目状态恢复待审阅：保留现有改动"));
  await shell.screenshot({ path: join(output, "neutral-agent-recovery.png") });
  await shell.reload();
  await shell.waitForSelector('.composer[data-mode="resume"] [data-testid="composer-input"]');
  await expandSidebar();

  await shell.click(taskRow(result.state.objective));
  console.log("probe: result row");
  await shell.waitForSelector('.task-results a[download="result.txt"]');
  await shell.screenshot({ path: join(output, "result-card.png") });
  await shell.click('[aria-label="设置 (Ctrl+,)"]');
  console.log("probe: settings");
  await shell.waitForSelector('.settings-view');
  await shell.screenshot({ path: join(output, "settings-1080.png") });
  const geometry = await shell.evaluate(() => {
    const section = document.querySelector(".settings-content")!.getBoundingClientRect();
    return { viewport: innerWidth, left: section.left, right: section.right, height: section.height };
  });
  if (geometry.left < 0 || geometry.right > geometry.viewport || geometry.height < 200) throw new Error(`Settings overflow: ${JSON.stringify(geometry)}`);
  console.log(JSON.stringify({ ok: true, output, initial, waitingState, geometry }));
} finally {
  if (browser) await browser.disconnect().catch(() => undefined);
  electron.kill();
  await Promise.race([electron.exited, Bun.sleep(5_000)]);
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}
