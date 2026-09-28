import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL, runTask, type RunEvent } from "../src/runtime/omp-runner";
import type { WorkBatchReport } from "../src/runtime/work-orders";

const root = resolve(".alpha", "probes", `agent-preset-coordinator-${randomUUID()}`);
const product = join(root, "product");
const dataRoot = join(root, "state");
await mkdir(join(product, "src"), { recursive: true });
await writeFile(join(product, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { build: "bun run build.ts" } }));
await writeFile(join(product, "build.ts"), `import { cp, mkdir } from "node:fs/promises"; await mkdir("dist", { recursive: true }); await cp("index.html", "dist/index.html"); await cp("src", "dist/src", { recursive: true });\n`);
await writeFile(join(product, "index.html"), `<!doctype html><html lang="zh"><meta charset="utf-8"><title>主代理角色选择探针</title><button id="show">显示</button><p id="out">待实现</p><script type="module">import { renderLabel } from './src/client.js'; import { getStatus } from './src/api.js'; document.querySelector('#show').onclick = () => document.querySelector('#out').textContent = renderLabel() + ' / ' + getStatus();</script></html>`);
await writeFile(join(product, "src", "client.js"), `export function renderLabel() { return "待实现"; }\n`);
await writeFile(join(product, "src", "api.js"), `export function getStatus() { return "待实现"; }\n`);

const events: RunEvent[] = [];
let taskId: string | undefined;
try {
  const ledger = await runTask({
    projectRoot: product, dataRoot,
    objective: "完成这个静态应用的两个独立源码部分。请使用恰好两个独立的子代理工单并从可用角色预设中自动选择适合各工单的角色：一人只修改 src/client.js，使 renderLabel 返回「前端已就绪」；另一人只修改 src/api.js，使 getStatus 返回「后端已就绪」。两条路径和资源不重叠。合并后检查构建。不要启动服务。",
    modelSelector: process.env.ALPHA_PROBE_MODEL ?? DEFAULT_MODEL,
    maxToolCalls: 25, wallTimeMs: 180_000,
    onEvent(event) { events.push(event); },
    onLedger(ledger) { taskId = ledger.state.id; },
  });
  const batches = await readdir(join(dataRoot, "workers", ledger.state.id));
  const reports = await Promise.all(batches.map(async batch => JSON.parse(await readFile(join(dataRoot, "workers", ledger.state.id, batch, "merge.json"), "utf8")) as WorkBatchReport));
  const merged = reports.find(report => report.status === "merged");
  const clientOrder = Object.entries(merged?.changes ?? {}).find(([, paths]) => paths.includes("src/client.js"))?.[0];
  const apiOrder = Object.entries(merged?.changes ?? {}).find(([, paths]) => paths.includes("src/api.js"))?.[0];
  const client = await readFile(join(product, "src", "client.js"), "utf8");
  const api = await readFile(join(product, "src", "api.js"), "utf8");
  const result = { root, taskId, status: ledger.state.status, events, reports, client, api };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  if (!merged || !clientOrder || !apiOrder || merged.experts?.[clientOrder]?.id !== "frontend" || merged.experts?.[apiOrder]?.id !== "backend" || !client.includes("前端已就绪") || !api.includes("后端已就绪")) {
    throw new Error(`Coordinator role selection did not meet probe expectations; evidence: ${join(root, "result.json")}`);
  }
  console.log(JSON.stringify({ ready: true, result: join(root, "result.json"), taskId, roles: merged.experts, tools: events.filter(event => event.type === "tool-start").map(event => event.value) }));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ taskId, events, error: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
}
