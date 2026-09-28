import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
const revise = Bun.argv[2] === "--revise";
const quality = Bun.argv[2] === "--quality";
const math = Bun.argv[2] === "--math";
const resumeOutput = Bun.argv[2] === "--resume" || revise || quality || math ? resolve(Bun.argv[3] ?? "") : null;
const output = resumeOutput ?? resolve(Bun.argv[2] ?? join(appRoot, "artifacts", `complex-task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`));
const workspace = join(output, "workspace");
await mkdir(workspace, { recursive: true });

const orders = `order_id,order_date,updated_at,product,currency,quantity,unit_price,status
O1,2026-01-03,2026-01-04T09:00:00Z,Alpha,USD,2,50,paid
O2,2026-01-05,2026-01-06T09:00:00Z,Beta,EUR,1,80,paid
O3,2026-01-07,2026-01-08T09:00:00Z,Alpha,USD,1,30,refunded
O4,2026-02-01,2026-02-02T09:00:00Z,Alpha,EUR,3,20,paid
O5,2026-02-05,2026-02-06T09:00:00Z,Beta,USD,1,75,paid
O6,2026-02-10,2026-02-11T09:00:00Z,Beta,EUR,1,10,refunded
O7,2026-02-12,2026-02-13T09:00:00Z,Gamma,USD,2,15,paid
O8,2026-03-03,2026-03-04T09:00:00Z,Alpha,USD,1,200,paid
O9,2026-03-04,2026-03-05T09:00:00Z,Gamma,EUR,2,40,paid
O10,2026-03-06,2026-03-07T09:00:00Z,Beta,USD,1,25,refunded
O2,2026-01-05,2026-01-10T09:00:00Z,Beta,EUR,1,100,paid
O11,2026-02-31,2026-03-01T09:00:00Z,Alpha,USD,1,20,paid
O12,2026-02-18,2026-02-19T09:00:00Z,Gamma,USD,0,20,paid
O13,2026-02-20,2026-02-21T09:00:00Z,Gamma,GBP,1,30,paid
O14,2026-03-20,2026-03-21T09:00:00Z,Alpha,USD,1,40,pending
`;
const rates = `month,currency,usd_rate
2026-01,USD,1
2026-01,EUR,1.2
2026-02,USD,1
2026-02,EUR,1.1
2026-03,USD,1
2026-03,EUR,1.15
`;
const rules = `# 订单核算规则

1. 同一 order_id 只保留 updated_at 最新的一行，旧行计入 superseded。先去重，再做有效性检查。
2. order_date 必须是真实的 YYYY-MM-DD 日期；quantity 必须大于 0，unit_price 不得小于 0。无对应月份和币种的汇率时计入 missingRate。status 为 pending 时计入 pending，不参与金额和退款率。
3. 每个有效订单的 USD 金额 = quantity × unit_price × 对应月份的 usd_rate。paid 为正，refunded 为负。按每行四舍五入到美分后求和。
4. refundRate = 有效 refunded 订单数 / 有效订单数。报告中展示为百分比。
5. 只使用这三份本地材料，不联网。报告说明处理顺序、排除原因和独立核算结果。
`;
const expected = {
  months: [{ month: "2026-01", netUsd: 190 }, { month: "2026-02", netUsd: 160 }, { month: "2026-03", netUsd: 267 }],
  productNetUsd: { Alpha: 336, Beta: 159, Gamma: 122 },
  includedOrders: 10,
  excludedRows: { superseded: 1, invalidDate: 1, invalidQuantity: 1, missingRate: 1, pending: 1 },
  refundRate: 0.3,
  totalNetUsd: 617,
};
await writeFile(join(output, "expected.json"), JSON.stringify(expected, null, 2));

const env = { ...process.env, ALPHA_WORKSPACE_ROOT: workspace, ALPHA_BUN_PATH: process.execPath };
const server = Bun.spawn([process.execPath, join(appRoot, "src", "server.ts")], { cwd: appRoot, env, stdout: "pipe", stderr: "pipe" });
let serverOutput = "";
const stdout = (async () => {
  const reader = server.stdout.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    serverOutput += new TextDecoder().decode(chunk.value);
    if (serverOutput.length > 80_000) serverOutput = serverOutput.slice(-80_000);
  }
})();
const stderr = (async () => {
  const reader = server.stderr.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    serverOutput += new TextDecoder().decode(chunk.value);
    if (serverOutput.length > 80_000) serverOutput = serverOutput.slice(-80_000);
  }
})();

let base = "";
let taskId = "";
try {
  const startDeadline = Date.now() + 20_000;
  while (Date.now() < startDeadline && !/ALPHA_SERVER_READY (\d+)/.test(serverOutput)) await Bun.sleep(100);
  const port = /ALPHA_SERVER_READY (\d+)/.exec(serverOutput)?.[1];
  if (!port) throw new Error(`Isolated server did not start: ${serverOutput.slice(-2000)}`);
  base = `http://127.0.0.1:${port}`;
  const catalog = await (await fetch(`${base}/api/models`)).json() as { default: string | null; builtin: string; models: Array<{ selector: string; available: boolean }> };
  const selectedModel = catalog.default ?? catalog.builtin;
  if (!catalog.models.some(item => item.selector === selectedModel && item.available)) throw new Error(`Configured model is unavailable: ${selectedModel}`);
  console.log(JSON.stringify({ event: "model-ready", model: selectedModel, output }));

  const form = new FormData();
  let createdResponse: Response;
  if (resumeOutput) {
    taskId = (JSON.parse(await readFile(join(output, "result.json"), "utf8")) as { taskId: string }).taskId;
    form.set("text", math
      ? "独立核算发现内容错误：报告逐月明细明确列出 O1 到 O10 共 10 笔有效订单，三笔退款是 O3、O6、O10，因此 includedOrders 必须是 10，refundRate 必须是 3/10 = 0.3（30%），不是 9 和 0.33。请同时修正 outputs/metrics.json 与 outputs/report.md 中这两个数字，重新检查其他数值和排除数量，保持 alpha-deliverable.json 不变，再验收新目标版本。"
      : quality
      ? "请修订已交付报告中的可核查错误：orders.csv 有 15 条数据行，另有 1 行表头，不能写成‘15 行原始数据（含表头）’。请准确改成‘15 条数据行（不含表头）’，并保留去重后 14 个唯一订单的结论。删去未由 rules.md 支持的‘发现需修正记录应在下期报告更新、而非追溯调整’建议；合并连续的两条水平分隔线。只修改 outputs/report.md，保持 metrics.json 和 alpha-deliverable.json 不变，再完成新目标版本验收。"
      : revise
      ? "请修订已交付报告：在 outputs/report.md 末尾增加“复核建议”小节，明确建议抽检重复订单 O2 和三笔退款 O3、O6、O10，并说明这不改变当前净收入。保持 metrics.json 和 alpha-deliverable.json 的内容不变，再完成新目标版本的验收。"
      : '输出数值已经核对正确，但 alpha-deliverable.json 的顶层键写成了 deliverables，验收器要求 outputs。请只将清单改成准确的 JSON：{"outputs":[{"path":"outputs/metrics.json"},{"path":"outputs/report.md"}]}。不要改动两个成果的内容，然后重新完成验收。');
    createdResponse = await fetch(`${base}/api/tasks/${taskId}/messages`, { method: "POST", body: form });
  } else {
    form.set("objective", `请完成一个可核查的本地订单分析交付。读取附件 orders.csv、rates.csv 和 rules.md，严格按规则清洗和计算。交付 outputs/metrics.json（字段和结构必须与以下模板相同：months:[{month,netUsd}], productNetUsd:{Alpha,Beta,Gamma}, includedOrders, excludedRows:{superseded,invalidDate,invalidQuantity,missingRate,pending}, refundRate（0 到 1 的数字）, totalNetUsd）以及 outputs/report.md（中文，含逐月表、产品净收入、退款率、每类排除数量与方法说明）。再写 alpha-deliverable.json 列出这两个成果的相对路径。不要联网；不要把附件复制到工作区充当成果。`);
    form.set("model", selectedModel);
    form.set("startMode", "execute");
    form.set("continueUntilAccepted", "false");
    form.set("skillIds", "[]");
    form.set("pluginIds", "[]");
    for (const [name, content, mime] of [["orders.csv", orders, "text/csv"], ["rates.csv", rates, "text/csv"], ["rules.md", rules, "text/markdown"]] as const) form.append("files", new File([content], name, { type: mime }));
    createdResponse = await fetch(`${base}/api/tasks/general`, { method: "POST", body: form });
  }
  const created = await createdResponse.json() as { taskId?: string; runId?: string | null; error?: string };
  if (!createdResponse.ok || !created.taskId) throw new Error(`Task creation failed: ${JSON.stringify(created)}`);
  taskId = created.taskId;
  console.log(JSON.stringify({ event: "task-created", taskId, runId: created.runId }));

  const deadline = Date.now() + 8 * 60_000;
  let lastStatus = "";
  let task: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const [detail, list] = await Promise.all([
      fetch(`${base}/api/tasks/${taskId}`).then(response => response.json()) as Promise<{ task: Record<string, unknown> }>,
      fetch(`${base}/api/tasks`).then(response => response.json()) as Promise<{ runs: Array<{ runId: string; taskId: string | null }> }>,
    ]);
    task = detail.task;
    const runId = list.runs.find(run => run.taskId === taskId)?.runId;
    const status = `${task.status}/${task.phase}/${runId ? "running" : "idle"}`;
    if (status !== lastStatus) { console.log(JSON.stringify({ event: "status", status, pending: task.pending, lastFailure: task.lastFailure })); lastStatus = status; }
    if (!runId && !task.queued) break;
    await Bun.sleep(3_000);
  }
  // Cancelling by task id stops only this probe's run, whatever else is running.
  await fetch(`${base}/api/tasks/${taskId}/cancel`, { method: "POST" });
  const projectRoot = typeof task.projectRoot === "string" ? task.projectRoot : "";
  const metricsPath = projectRoot ? join(projectRoot, "outputs", "metrics.json") : "";
  const reportPath = projectRoot ? join(projectRoot, "outputs", "report.md") : "";
  const manifestPath = projectRoot ? join(projectRoot, "alpha-deliverable.json") : "";
  const metricsText = metricsPath ? await readFile(metricsPath, "utf8").catch(() => "") : "";
  const report = reportPath ? await readFile(reportPath, "utf8").catch(() => "") : "";
  const manifest = manifestPath ? await readFile(manifestPath, "utf8").catch(() => "") : "";
  let metricsMatch = false;
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  try { metricsMatch = canonical(JSON.parse(metricsText)) === canonical(expected); } catch { /* Missing or invalid output is a test result. */ }
  const result = { taskId, status: task.status, phase: task.phase, contractVersion: task.contractVersion, inputCount: Array.isArray(task.inputs) ? task.inputs.length : 0,
    criteria: task.criteria, evidence: task.evidence, lastFailure: task.lastFailure, pending: task.pending,
    files: { metricsPath, reportPath, manifestPath, metricsExists: !!metricsText, reportExists: !!report, manifestExists: !!manifest }, metricsMatch,
    reportMentionsTotal: report.includes("617"), reportMentionsRefunds: report.includes("30%") || report.includes("30 %"),
    reportMentionsReview: report.includes("复核建议") && report.includes("O2") && report.includes("O10"),
    reportRowCountCorrect: report.includes("15 条数据行（不含表头）") && !report.includes("15 行原始数据（含表头）"),
  };
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(join(output, "server.log"), serverOutput);
  console.log(JSON.stringify({ event: "result", output, taskId, status: result.status, metricsMatch, reportExists: !!report, manifestExists: !!manifest, lastFailure: result.lastFailure }));
} finally {
  server.kill();
  await Promise.race([server.exited, Bun.sleep(5_000)]);
  await Promise.allSettled([stdout, stderr]);
  if (serverOutput) await writeFile(join(output, "server.log"), serverOutput);
}
