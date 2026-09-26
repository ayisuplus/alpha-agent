import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TaskLedger } from "../src/runtime/task-ledger";
import { runTask } from "../src/runtime/omp-runner";
import { runDevelopmentWorkflow } from "../src/runtime/development-workflow";

const option = (name: string) => Bun.argv.includes(name) ? Bun.argv[Bun.argv.indexOf(name) + 1] : undefined;
const model = option("--model") ?? "xiaomi-token-plan-cn/mimo-v2.6-flash";
const evaluationRoot = resolve(option("--output") ?? resolve(import.meta.dir, "..", ".alpha", "workflow-evaluation", "2026-09-25"));
const cases = [
  {
    id: "clamp",
    source: "export function clamp(value: number, min: number, max: number): number {\n  return value;\n}\n",
    test: "import { expect, test } from 'bun:test';\nimport { clamp } from './app';\ntest('clamp bounds', () => { expect(clamp(-4, 0, 10)).toBe(0); expect(clamp(14, 0, 10)).toBe(10); expect(clamp(5, 0, 10)).toBe(5); });\n",
    objective: "Fix clamp(value, min, max) in app.ts so values outside the inclusive range return the nearest bound. Preserve the export and do not change app.test.ts. Run the configured tests and report actual evidence.",
  },
  {
    id: "query",
    source: "export function parseQuery(text: string): Record<string, string> {\n  return Object.fromEntries(text.replace(/^\\?/, '').split('&').map(part => part.split('=')));\n}\n",
    test: "import { expect, test } from 'bun:test';\nimport { parseQuery } from './app';\ntest('query parameters', () => { expect(parseQuery('?name=Ada&token=a=b')).toEqual({name:'Ada',token:'a=b'}); expect(parseQuery('')).toEqual({}); });\n",
    objective: "Fix parseQuery in app.ts. A value may contain an equals sign, and empty input must yield an empty object. Keep the exported API and do not edit app.test.ts. Run the configured tests.",
  },
  {
    id: "label",
    source: "export function formatLabel(name: string, count: number): string {\n  return name + ': ' + count + ' items';\n}\n",
    test: "import { expect, test } from 'bun:test';\nimport { formatLabel } from './app';\ntest('count labels', () => { expect(formatLabel('Book', 0)).toBe('Book: 0 items'); expect(formatLabel('Book', 1)).toBe('Book: 1 item'); expect(formatLabel('Book', 2)).toBe('Book: 2 items'); });\n",
    objective: "Fix formatLabel in app.ts so count 1 uses singular 'item' while other counts use 'items'. Preserve the exported API and do not change app.test.ts. Run the configured tests.",
  },
] as const;

const selectedCase = option("--case");
const selectedMode = option("--mode");
if (selectedCase && !cases.some(item => item.id === selectedCase)) throw new Error("Unknown comparison case");
if (selectedMode && selectedMode !== "single" && selectedMode !== "workflow") throw new Error("Unknown comparison mode");

await mkdir(evaluationRoot, { recursive: true });
for (const item of cases) for (const mode of ["single", "workflow"] as const) {
  if (selectedCase && selectedCase !== item.id) continue;
  if (selectedMode && selectedMode !== mode) continue;
  const directory = join(evaluationRoot, `${item.id}-${mode}`);
  const resultFile = join(directory, "result.json");
  if (await Bun.file(resultFile).exists()) { console.log(`${item.id}/${mode}: already recorded`); continue; }
  const projectRoot = join(directory, "project");
  const dataRoot = join(directory, "state");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "app.ts"), item.source);
  await writeFile(join(projectRoot, "app.test.ts"), item.test);
  await writeFile(join(projectRoot, "package.json"), JSON.stringify({ scripts: { test: "bun test app.test.ts" } }));
  const testHash = createHash("sha256").update(item.test).digest("hex");
  const ledger = await TaskLedger.create(dataRoot, {
    objective: item.objective, projectRoot, taskType: "code-change", workspaceOrigin: { kind: "copy", checks: [{ name: "test", command: "bun test app.test.ts" }] },
    criteria: [{ id: "change", description: "Source changed", kind: "asset" }, { id: "check", description: "Tests passed", kind: "test" }], modelSelector: model,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Eight-minute comparison limit")), 480_000);
  const started = performance.now();
  let error: string | null = null;
  try {
    const run = mode === "workflow" ? runDevelopmentWorkflow : runTask;
    await run({ projectRoot, dataRoot, existingLedger: ledger, objective: item.objective, modelSelector: model, signal: controller.signal, maxToolCalls: 80, maxTotalToolCalls: 80, wallTimeMs: 480_000, totalWallTimeMs: 480_000 });
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  finally { clearTimeout(timeout); }
  const current = await TaskLedger.load(ledger.file);
  const check = Bun.spawn(["bun", "test", "app.test.ts"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([check.exited, new Response(check.stdout).text(), new Response(check.stderr).text()]);
  const unchangedTests = createHash("sha256").update(await readFile(join(projectRoot, "app.test.ts"))).digest("hex") === testHash;
  const result = {
    case: item.id, mode, model, wallTimeMs: Math.round(performance.now() - started), error, status: current.state.status,
    actualTestsPassed: exitCode === 0 && unchangedTests, testFileUnchanged: unchangedTests, testOutput: `${stdout}\n${stderr}`.slice(-1800),
    review: current.state.development?.review ?? null,
    toolCalls: (current.state.runs ?? []).reduce((sum, run) => sum + run.toolCalls, 0),
    totalTokens: (current.state.runs ?? []).reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0),
    cost: (current.state.runs ?? []).reduce((sum, run) => sum + (run.usage?.cost ?? 0), 0),
    repairs: current.state.development?.repairAttempts ?? 0,
    taskId: current.state.id,
  };
  await writeFile(resultFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ case: item.id, mode, actualTestsPassed: result.actualTestsPassed, review: result.review?.verdict ?? null, toolCalls: result.toolCalls, wallTimeMs: result.wallTimeMs, error }));
}
