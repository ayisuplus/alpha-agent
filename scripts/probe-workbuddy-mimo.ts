import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExpertStore } from "../src/runtime/experts";
import { acceptCodeChange } from "../src/runtime/code-acceptance";
import { runDevelopmentWorkflow } from "../src/runtime/development-workflow";
import { runModelWorkOrders } from "../src/runtime/model-workers";
import { fingerprintSource } from "../src/runtime/task-ledger";
import { importCodeWorkspace } from "../src/runtime/workspace-import";
import { bindWorkOrders } from "../src/runtime/worker-binding";
import type { VisibleBrowser } from "../src/runtime/visible-browser";

const projectRoot = resolve(import.meta.dir, "..");
const dataRoot = join(projectRoot, ".alpha");
const root = join(dataRoot, "mimo-tests", randomUUID());
const fixtureRoot = join(tmpdir(), `alpha-mimo-${randomUUID()}`);
const reportFile = join(root, "report.json");
const model = "xiaomi-token-plan-cn/mimo-v2.6-flash";
const report: Record<string, unknown> = { root, model, startedAt: new Date().toISOString() };
await mkdir(root, { recursive: true });
async function save() { await writeFile(reportFile, JSON.stringify(report, null, 2)); }
async function fixture(name: string): Promise<string> {
  const source = join(fixtureRoot, name);
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "test"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "mimo-cart-check", private: true, type: "module", scripts: { test: "bun test ./test/cart.test.ts" } }, null, 2));
  await writeFile(join(source, "src", "cart.ts"), "export function calculateTotal(items: Array<{ price: number; quantity: number }>): number {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n");
  await writeFile(join(source, "test", "cart.test.ts"), "import { expect, test } from 'bun:test';\nimport { calculateTotal } from '../src/cart';\ntest('multiplies each price by quantity and sums all lines', () => { expect(calculateTotal([{ price: 12, quantity: 2 }, { price: 3, quantity: 3 }])).toBe(33); });\n");
  return source;
}
async function check(source: string): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn([process.execPath, "run", "test"], { cwd: source, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}\n${stderr}`.slice(-3000) };
}

const experts = await new ExpertStore(dataRoot).enabled();
const coach = experts.find(item => item.source?.path === "engineering-workflow-skills/agents/engineering-workflow-coach.md");
if (!coach) throw new Error("Imported engineering workflow expert is missing");
report.expert = { id: coach.id, name: coach.name, skills: coach.skillIds, packageRevision: coach.package?.revision };
await save();

try {
  const source = await fixture("browser-source");
  const [order] = bindWorkOrders([{ id: "browser", objective: "Use alpha_browser observe on the connected local preview. Verify its visible text contains 'Cart total: 33' and there are no console errors. Report the observed browser evidence and a review verdict; do not change files.", mode: "review", ownedPaths: [], readPaths: ["src/cart.ts"], resources: [] }], [coach]);
  let browserCalls = 0;
  const observation = { title: "Cart", url: "http://127.0.0.1:8123/", text: "Cart total: 33", controls: [], consoleErrors: [], failedRequests: [], brokenImages: [], viewport: { width: 1280, height: 800, horizontalOverflow: false } };
  const browser = { observe: async () => { browserCalls++; return observation; } } as unknown as VisibleBrowser;
  const result = await runModelWorkOrders({ projectRoot: source, dataRoot, taskId: randomUUID(), baseRevision: await fingerprintSource(source), orders: [order], modelSelector: model, browser, browserUrl: observation.url, browserAccess: () => true, signal: AbortSignal.timeout(180_000) });
  report.browser = { status: result.status, reason: result.reason, result: result.results.browser, browserCalls };
} catch (error) { report.browser = { error: error instanceof Error ? error.message : String(error) }; }
await save();
if (process.argv.includes("--browser-only")) {
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(reportFile);
  process.exit(0);
}

try {
  const source = await fixture("capability-source");
  const [order] = bindWorkOrders([{ id: "visual", objective: "The requested acceptance needs a real browser inspection of the rendered UI, which this isolated worker cannot do directly. Record an exact browser capability request to the coordinator, then report needs-context; do not claim visual verification.", mode: "review", ownedPaths: [], readPaths: ["src/cart.ts"], resources: [] }], [coach]);
  const result = await runModelWorkOrders({ projectRoot: source, dataRoot, taskId: randomUUID(), baseRevision: await fingerprintSource(source), orders: [order], modelSelector: model, signal: AbortSignal.timeout(180_000) });
  report.capability = { status: result.status, reason: result.reason, result: result.results.visual, committed: result.committed };
} catch (error) { report.capability = { error: error instanceof Error ? error.message : String(error) }; }
await save();

try {
  const source = await fixture("worker-source");
  const [order] = bindWorkOrders([{ id: "cart", objective: "Fix calculateTotal so it multiplies price by quantity and passes the existing cart test. Keep the public signature.", mode: "implement", ownedPaths: ["src/cart.ts"], readPaths: ["test/cart.test.ts", "package.json"], resources: [], acceptance: ["Existing cart test passes"] }], [coach]);
  const usage: unknown[] = [];
  const result = await runModelWorkOrders({ projectRoot: source, dataRoot, taskId: randomUUID(), baseRevision: await fingerprintSource(source), orders: [order], modelSelector: model, signal: AbortSignal.timeout(180_000), onWorkerUsage: (_order, value) => { usage.push(value); } });
  report.worker = { status: result.status, reason: result.reason, changed: result.changes, results: result.results, usage, source: await readFile(join(source, "src", "cart.ts"), "utf8"), check: await check(source) };
} catch (error) { report.worker = { error: error instanceof Error ? error.message : String(error) }; }
await save();

try {
  const source = await fixture("code-source");
  const objective = "Fix calculateTotal in src/cart.ts so every line uses price times quantity; preserve the public function signature and make the existing project test pass.";
  const ledger = await importCodeWorkspace({ sourcePath: source, productsRoot: join(projectRoot, "products"), dataRoot, objective, modelSelector: model, designatedExpertId: coach.id });
  report.codeTaskId = ledger.state.id;
  await save();
  const events: Array<{ type: string; value: string; error?: boolean }> = [];
  const result = await runDevelopmentWorkflow({ projectRoot: ledger.state.projectRoot, dataRoot, objective, modelSelector: model, existingLedger: ledger, maxToolCalls: 80, wallTimeMs: 480_000, maxTotalToolCalls: 80, totalWallTimeMs: 480_000, signal: AbortSignal.timeout(480_000), onEvent: event => { if (events.length < 100) events.push({ type: event.type, value: event.value.slice(0, 400), error: event.error }); } });
  let accepted: boolean | string = false;
  if (result.state.status === "active") {
    try { accepted = await acceptCodeChange({ ledger: result, dataRoot, runId: randomUUID() }); }
    catch (error) { accepted = error instanceof Error ? error.message : String(error); }
  }
  report.code = { status: result.state.status, accepted, gaps: result.completionGaps(), review: result.state.development?.review, instances: result.state.cognition?.instances, runs: result.state.runs, source: await readFile(join(ledger.state.projectRoot, "src", "cart.ts"), "utf8"), check: await check(ledger.state.projectRoot), events };
} catch (error) { report.code = { error: error instanceof Error ? error.message : String(error) }; }
report.finishedAt = new Date().toISOString();
await save();
console.log(reportFile);
