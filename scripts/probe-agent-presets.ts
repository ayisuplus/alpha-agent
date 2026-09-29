import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExpertStore } from "../src/runtime/experts";
import { DEFAULT_MODEL } from "../src/runtime/omp-runner";
import { runModelWorkOrders } from "../src/runtime/model-workers";
import { bindWorkOrders } from "../src/runtime/worker-binding";
import { fingerprintSource } from "../src/runtime/task-ledger";
import { publishLocalPreview } from "../src/runtime/local-preview";

const root = resolve(".alpha", "probes", `agent-presets-${randomUUID()}`);
const product = join(root, "product");
const dataRoot = join(root, "state");
await mkdir(join(product, "src"), { recursive: true });
await writeFile(join(product, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { build: "bun run build.ts" } }));
await writeFile(join(product, "build.ts"), `import { cp, mkdir } from "node:fs/promises"; await mkdir("dist", { recursive: true }); await cp("index.html", "dist/index.html"); await cp("src", "dist/src", { recursive: true });\n`);
await writeFile(join(product, "index.html"), `<!doctype html><html lang="zh"><meta charset="utf-8"><title>角色预设探针</title><style>body{font:18px sans-serif;color:#16202a;background:#fff;padding:32px}button{font:inherit}</style><h1>角色预设探针</h1><button id="show">显示结果</button><p id="result">等待点击</p><script type="module">import { label } from './src/ui.js'; import { value } from './src/data.js'; document.querySelector('#show').addEventListener('click', () => { document.querySelector('#result').textContent = label() + ' / ' + value(); });</script></html>`);
await writeFile(join(product, "src", "ui.js"), `export function label() { return "待实现"; }\n`);
await writeFile(join(product, "src", "data.js"), `export function value() { return "待实现"; }\n`);
const presets = await new ExpertStore(dataRoot).enabled();
const orders = await bindWorkOrders([
  { id: "frontend", objective: 'In src/ui.js, replace only the returned Chinese string "待实现" with "前端已就绪". Keep the function and all other files unchanged.', ownedPaths: ["src/ui.js"], resources: ["ui"]},
  { id: "backend", objective: 'In src/data.js, replace only the returned Chinese string "待实现" with "后端已就绪". Keep the function and all other files unchanged.', ownedPaths: ["src/data.js"], resources: ["data"]},
], presets, [], dataRoot);
const events: string[] = [];
const report = await runModelWorkOrders({
  projectRoot: product, dataRoot, taskId: randomUUID(), baseRevision: await fingerprintSource(product), orders,
  modelSelector: process.env.ALPHA_PROBE_MODEL ?? DEFAULT_MODEL,
  onWorkerEvent(order, state) { events.push(`${order.id}:${state}`); },
});
const result = { root, report, events, ui: await readFile(join(product, "src", "ui.js"), "utf8"), data: await readFile(join(product, "src", "data.js"), "utf8") };
await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
if (report.status !== "merged" || !result.ui.includes("前端已就绪") || !result.data.includes("后端已就绪")) throw new Error(`Role worker probe failed: ${report.reason ?? report.status}; evidence: ${join(root, "result.json")}`);
const build = Bun.spawn([process.execPath, "run", "build"], { cwd: product, stdout: "pipe", stderr: "pipe" });
const [buildOutput, buildError, exit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
if (exit !== 0) throw new Error(`Integrated build failed: ${buildOutput}\n${buildError}`);
const preview = await publishLocalPreview({ projectRoot: product, buildDir: join(product, "dist"), dataRoot, revision: await fingerprintSource(product) });
console.log(JSON.stringify({ ready: true, result: join(root, "result.json"), url: preview.record.url, report: report.status, presets: report.experts }));
await new Promise<void>(done => process.once("SIGINT", done));
preview.stop();
