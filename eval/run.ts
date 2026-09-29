// Alpha's harness evaluation. Starts an isolated Alpha server, gives it each task in eval/tasks through the same HTTP
// API the workbench uses, waits for it to finish, and grades the result with checks the agent never sees (hidden tests
// for code tasks, answer and file checks for general tasks).
//
//   bun run eval                              run every task against this checkout
//   bun run eval --app <dir> --label head     run against another checkout, e.g. an older commit
//   bun run eval --tasks cart-rounding,lru-cache --concurrency 2
//   bun run eval --selfcheck                  prove every hidden check fails on the original code and passes on a fix
//   bun run eval compare <resultsA> <resultsB>
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const tasksRoot = join(repo, "eval", "tasks");

interface TaskSpec {
  id: string;
  kind: "code" | "general";
  objective: string;
  files?: string[];
  hidden?: string[];
  checks?: {
    answer?: { patterns?: string[]; forbidden?: string[]; hanChars?: [number, number] };
    file?: { path: string; rows: string[][] };
    /** Content check for a delivered text file (scripts, briefs): patterns must appear, forbidden must not. */
    text?: { path: string; patterns?: string[]; forbidden?: string[]; hanChars?: [number, number] };
  };
  /**
   * Keep a paused task moving without a person: when it reaches `needs-input`, wait `afterSeconds` and resume with
   * `brief`, at most `times` times. This is what makes a multi-round pause/resume task testable unattended.
   */
  autoResume?: { times?: number; brief?: string; afterSeconds?: number };
}

/** What the plan graph did during the run, read from the task event log (not model-reported). */
export interface PlanMetricRecord {
  /** alpha_plan submissions (plan/submitted). */
  plans: number;
  /** alpha_plan revisions of an existing graph (plan/revised). */
  revisions: number;
  reworkReopens: number;
  premiseReopens: number;
  /** Reopens without an edge: redoing stale or expired work. */
  redoReopens: number;
  /** Review gate verdicts of changes-requested. */
  changesRequested: number;
}

interface RunRecord { model: string; stage?: string; toolCalls: number; elapsedMs: number; firstResponseMs?: number; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: number }; prompt?: { systemTokens: number; toolTokens: number; tools: number; contextShare: number | null }; outcome: string; failureReason?: string }
interface StepContextRecord { stage: string; model: string; taskContextBytes: number; systemTokens: number; toolTokens: number; contextShare: number | null; tools: number; recordedAt: string }

export interface TaskResult {
  id: string;
  kind: TaskSpec["kind"];
  /** Alpha's own verdict: complete means its acceptance passed. */
  alphaStatus: string;
  /** The independent grade. */
  passed: boolean;
  /** Alpha accepted the task but the independent grade failed. */
  falseAcceptance: boolean;
  detail: string;
  wallMs: number;
  runs: number;
  toolCalls: number;
  /** input + output + cache reads + cache writes, as the provider reports them. */
  tokens: number;
  /** Fresh input plus output: re-sent context that the provider served from its cache is reported separately. */
  freshTokens: number;
  cacheReadTokens: number;
  prompt: RunRecord["prompt"] | null;
  /** Slowest first model response across the task's runs, and the largest task context block a step was given. */
  firstResponseMs: number | null;
  contextBytes: number;
  /** How many times the runner had to resume a paused task (only tasks with `autoResume`). */
  pauses: number;
  models: string[];
  lastFailure: string | null;
  timedOut: boolean;
  plan: PlanMetricRecord;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadTasks(filter?: string): Promise<TaskSpec[]> {
  const wanted = filter ? new Set(filter.split(",")) : null;
  const ids = (await readdir(tasksRoot)).filter(id => !wanted || wanted.has(id)).sort();
  return Promise.all(ids.map(async id => JSON.parse(await readFile(join(tasksRoot, id, "task.json"), "utf8")) as TaskSpec));
}

async function run(command: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@localhost", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@localhost" } });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { code, output: `${stdout}\n${stderr}` };
}

/** Runs a code task's hidden tests against a copy of the given project. */
async function hiddenTests(task: TaskSpec, projectRoot: string, overlay?: string): Promise<{ passed: boolean; output: string }> {
  const copy = await mkdtemp(join(tmpdir(), `alpha-grade-${task.id}-`));
  try {
    await cp(projectRoot, copy, { recursive: true, filter: source => !/[\\/](node_modules|\.git)([\\/]|$)/.test(source) });
    if (overlay) await cp(overlay, copy, { recursive: true });
    await mkdir(join(copy, "hidden"), { recursive: true });
    for (const file of task.hidden ?? []) await cp(join(tasksRoot, task.id, file), join(copy, "hidden", basename(file)));
    const result = await run([process.execPath, "test", "./hidden"], copy);
    return { passed: result.code === 0, output: result.output.slice(-3_000) };
  } finally { await rm(copy, { recursive: true, force: true }).catch(() => undefined); }
}

function gradeAnswer(check: NonNullable<NonNullable<TaskSpec["checks"]>["answer"]>, answer: string): string[] {
  const problems: string[] = [];
  for (const pattern of check.patterns ?? []) if (!new RegExp(pattern).test(answer)) problems.push(`missing ${pattern}`);
  for (const word of check.forbidden ?? []) if (answer.includes(word)) problems.push(`uses ${word}`);
  if (check.hanChars) {
    const count = (answer.match(/\p{Script=Han}/gu) ?? []).length;
    if (count < check.hanChars[0] || count > check.hanChars[1]) problems.push(`${count} Chinese characters, expected ${check.hanChars[0]}–${check.hanChars[1]}`);
  }
  return problems;
}

async function gradeFile(check: NonNullable<NonNullable<TaskSpec["checks"]>["file"]>, projectRoot: string): Promise<string[]> {
  const text = await readFile(join(projectRoot, check.path), "utf8").catch(() => null);
  if (text === null) return [`${check.path} is missing`];
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter(line => line.trim()).map(line => line.split(",").map(cell => cell.trim().replace(/^"|"$/g, "")));
  return JSON.stringify(rows) === JSON.stringify(check.rows) ? [] : [`${check.path} content differs: ${JSON.stringify(rows).slice(0, 300)}`];
}

/** Every hidden check must fail on the original code and pass on the reference solution. */
async function selfcheck(tasks: TaskSpec[]): Promise<boolean> {
  let ok = true;
  for (const task of tasks) {
    if (task.kind === "code") {
      const original = await hiddenTests(task, join(tasksRoot, task.id, "repo"));
      const solved = await hiddenTests(task, join(tasksRoot, task.id, "repo"), join(tasksRoot, task.id, "solution"));
      const visible = await run([process.execPath, "test", "test"], join(tasksRoot, task.id, "repo"));
      const good = !original.passed && solved.passed && visible.code === 0;
      ok &&= good;
      console.log(`${good ? "ok  " : "FAIL"} ${task.id}: original ${original.passed ? "passes (should fail)" : "fails"}, solution ${solved.passed ? "passes" : `fails\n${solved.output}`}, visible tests ${visible.code === 0 ? "pass" : "fail"}`);
    } else if (task.checks?.file) {
      // The expected rows must follow from the attached data.
      const csv = (await readFile(join(tasksRoot, task.id, task.files![0]), "utf8")).trim().split(/\r?\n/).slice(1).map(line => line.split(","));
      const totals = new Map<string, number>();
      for (const [, region, , amount] of csv) totals.set(region, (totals.get(region) ?? 0) + Number(amount));
      const expected = [["region", "total"], ...[...totals].sort((a, b) => b[1] - a[1]).map(([region, total]) => [region, String(total)])];
      const good = JSON.stringify(expected) === JSON.stringify(task.checks.file.rows);
      ok &&= good;
      console.log(`${good ? "ok  " : "FAIL"} ${task.id}: expected rows ${good ? "match the data" : `differ: ${JSON.stringify(expected)}`}`);
    } else if (task.checks?.text) {
      // The scenario must carry the trap: every forbidden token has to appear in the attached material, otherwise the
      // check cannot be grading the model's compliance work.
      const material = (await Promise.all((task.files ?? []).map(file => readFile(join(tasksRoot, task.id, file), "utf8").catch(() => "")))).join("\n");
      const missing = (task.checks.text.forbidden ?? []).filter(word => !material.includes(word));
      const absent = (task.checks.text.patterns ?? []).filter(pattern => !new RegExp(pattern).test(material));
      const good = missing.length === 0;
      ok &&= good;
      console.log(`${good ? "ok  " : "FAIL"} ${task.id}: text check on ${task.checks.text.path}${missing.length ? `, forbidden words absent from the material: ${missing.join(", ")}` : ""}${absent.length ? ` (patterns the model must produce itself: ${absent.join(", ")})` : ""}`);
    } else console.log(`ok   ${task.id}: answer checks (${Object.keys(task.checks?.answer ?? {}).join(", ")})`);
  }
  return ok;
}

async function startServer(app: string, workspace: string): Promise<{ base: string; stop(): Promise<void> }> {
  const env: Record<string, string | undefined> = { ...process.env, ALPHA_WORKSPACE_ROOT: workspace };
  delete env.ALPHA_CDP_PORT;
  const child = Bun.spawn([process.execPath, "run", join(app, "src", "server.ts")], { cwd: app, env, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let output = "";
  let port: string | undefined;
  const deadline = Date.now() + 30_000;
  while (!port && Date.now() < deadline) {
    const part = await reader.read();
    if (part.done) break;
    output += new TextDecoder().decode(part.value);
    port = /ALPHA_SERVER_READY (\d+)/.exec(output)?.[1];
  }
  if (!port) { child.kill(); throw new Error(`Alpha server did not start: ${output}${await new Response(child.stderr).text()}`); }
  // Keep draining the server's output so it never blocks on a full pipe.
  void (async () => { while (!(await reader.read()).done) { /* discard */ } })();
  void new Response(child.stderr).text();
  return { base: `http://127.0.0.1:${port}`, async stop() { child.kill(); await child.exited; } };
}

/** An isolated workspace with the user's model settings and expert library, but no tasks, automations or secrets. */
async function prepareWorkspace(label: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `alpha-eval-${label}-`));
  const data = join(workspace, ".alpha");
  await mkdir(data, { recursive: true });
  for (const item of ["settings.json", "agent-presets.json", "expert-packs", "plugin-packs"]) {
    await cp(join(repo, ".alpha", item), join(data, item), { recursive: true }).catch(() => undefined);
  }
  return workspace;
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function api<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.json().catch(() => ({})) as T };
}

async function createTask(base: string, workspace: string, task: TaskSpec): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let response: { status: number; body: { taskId?: string; error?: string } };
    if (task.kind === "code") {
      const source = join(workspace, "fixtures", task.id);
      if (attempt === 0) {
        await cp(join(tasksRoot, task.id, "repo"), source, { recursive: true });
        for (const command of [["git", "init", "-q"], ["git", "add", "-A"], ["git", "commit", "-qm", "fixture"]]) {
          const result = await run(command, source);
          if (result.code !== 0) throw new Error(`${command.join(" ")} failed: ${result.output}`);
        }
      }
      response = await api(base, "/api/workspaces/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: source, objective: task.objective }) });
    } else {
      const form = new FormData();
      form.set("objective", task.objective);
      form.set("startMode", "execute");
      form.set("continueUntilAccepted", "false");
      form.set("skillIds", "[]");
      form.set("pluginIds", "[]");
      for (const file of task.files ?? []) form.append("files", Bun.file(join(tasksRoot, task.id, file)), basename(file));
      response = await api(base, "/api/tasks/general", { method: "POST", body: form });
    }
    if (response.body.taskId) return response.body.taskId;
    // An older single-run server refuses while another task runs; wait for the slot.
    if (response.status === 409 && attempt < 360) { await sleep(10_000); continue; }
    throw new Error(`Task creation failed (${response.status}): ${response.body.error ?? JSON.stringify(response.body)}`);
  }
}

async function waitForTask(base: string, taskId: string, timeoutMs: number, autoResume?: TaskSpec["autoResume"]): Promise<{ timedOut: boolean; pauses: number }> {
  const started = Date.now();
  let seenWork = false;
  let pauses = 0;
  // Every run boundary (plan approval, node switch, round repair) leaves the task briefly idle before the driver
  // starts the next run. An active task is only finished once it stays idle for this many polls.
  const idleLimit = 4;
  let idlePolls = 0;
  while (true) {
    const { body } = await api<{ task?: { running: boolean; queued?: boolean; status: string } }>(base, `/api/tasks/${taskId}`);
    const task = body.task;
    if (task) {
      if (task.running || task.queued) { seenWork = true; idlePolls = 0; }
      else if (task.status === "active" && seenWork && ++idlePolls < idleLimit) { await sleep(5_000); continue; }
      else if (task.status === "needs-input" && autoResume && pauses < (autoResume.times ?? 1)) {
        // A paused task with nobody at the keyboard would sit here until the timeout: resume it and count the pause.
        await sleep((autoResume.afterSeconds ?? 5) * 1_000);
        await api(base, `/api/tasks/${taskId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: autoResume.brief ?? "继续" }) });
        pauses++;
        seenWork = true;
        continue;
      } else if (seenWork || task.status !== "active" || Date.now() - started > 90_000) return { timedOut: false, pauses };
    }
    if (Date.now() - started > timeoutMs) {
      await api(base, `/api/tasks/${taskId}/cancel`, { method: "POST" });
      for (let wait = 0; wait < 24; wait++) {
        await sleep(5_000);
        const current = await api<{ task?: { running: boolean } }>(base, `/api/tasks/${taskId}`);
        if (!current.body.task?.running) break;
      }
      return { timedOut: true, pauses };
    }
    await sleep(5_000);
  }
}

async function gradeText(check: NonNullable<NonNullable<TaskSpec["checks"]>["text"]>, projectRoot: string): Promise<string[]> {
  const text = await readFile(join(projectRoot, check.path), "utf8").catch(() => null);
  if (text === null) return [`${check.path} is missing`];
  const problems: string[] = [];
  for (const pattern of check.patterns ?? []) if (!new RegExp(pattern).test(text)) problems.push(`${check.path} missing ${pattern}`);
  for (const word of check.forbidden ?? []) if (text.includes(word)) problems.push(`${check.path} uses ${word}`);
  if (check.hanChars) {
    const count = (text.match(/\p{Script=Han}/gu) ?? []).length;
    if (count < check.hanChars[0] || count > check.hanChars[1]) problems.push(`${count} Chinese characters in ${check.path}, expected ${check.hanChars[0]}–${check.hanChars[1]}`);
  }
  return problems;
}

/** Reads the plan graph's behaviour from the task event log: plans, revisions, back-edge traversals, gate verdicts. */
async function planMetrics(workspace: string, taskId: string): Promise<PlanMetricRecord> {
  const metrics: PlanMetricRecord = { plans: 0, revisions: 0, reworkReopens: 0, premiseReopens: 0, redoReopens: 0, changesRequested: 0 };
  const text = await readFile(join(workspace, ".alpha", "tasks", taskId, "events.v1.jsonl"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; payload?: Record<string, unknown> };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event.type === "plan/submitted") metrics.plans++;
    else if (event.type === "plan/revised") metrics.revisions++;
    else if (event.type === "node/reopened") {
      if (event.payload?.edge === "rework") metrics.reworkReopens++;
      else if (event.payload?.edge === "premise") metrics.premiseReopens++;
      else metrics.redoReopens++;
    } else if (event.type === "node/exited" && event.payload?.verdict === "changes-requested") metrics.changesRequested++;
  }
  return metrics;
}

async function runTask(base: string, workspace: string, task: TaskSpec, timeoutMs: number): Promise<TaskResult> {
  const started = Date.now();
  const taskId = await createTask(base, workspace, task);
  console.log(`start ${task.id} → ${taskId}`);
  const { timedOut, pauses } = await waitForTask(base, taskId, timeoutMs, task.autoResume);
  const ledger = JSON.parse(await readFile(join(workspace, ".alpha", "tasks", `${taskId}.json`), "utf8")) as { status: string; projectRoot: string; lastFailure?: string | null; runs?: RunRecord[]; stepContexts?: StepContextRecord[] };
  const runs = ledger.runs ?? [];
  const stepContexts = ledger.stepContexts ?? [];
  const problems: string[] = [];
  if (task.kind === "code") {
    const hidden = await hiddenTests(task, ledger.projectRoot);
    if (!hidden.passed) problems.push(`hidden tests failed:\n${hidden.output.split("\n").filter(line => /✗|\(fail\)|error:|Expected|Received/.test(line)).slice(0, 12).join("\n")}`);
  } else if (task.checks?.file) {
    problems.push(...await gradeFile(task.checks.file, ledger.projectRoot));
  }
  if (task.checks?.answer) {
    const { body } = await api<{ entries?: Array<{ kind: string; value: string }> }>(base, `/api/tasks/${taskId}/activity`);
    problems.push(...gradeAnswer(task.checks.answer, (body.entries ?? []).filter(entry => entry.kind === "text").map(entry => entry.value).join("")));
  }
  if (task.checks?.text) problems.push(...await gradeText(task.checks.text, ledger.projectRoot));
  const passed = problems.length === 0 && !timedOut;
  const coordinator = runs.find(item => item.prompt && (!item.stage || item.stage === "coordinator")) ?? runs.find(item => item.prompt);
  const plan = await planMetrics(workspace, taskId);
  const result: TaskResult = {
    id: task.id, kind: task.kind, alphaStatus: ledger.status, passed, falseAcceptance: ledger.status === "complete" && !passed,
    detail: timedOut ? "timed out" : problems.join("; ") || "all checks passed",
    wallMs: Date.now() - started, runs: runs.length,
    toolCalls: runs.reduce((sum, item) => sum + item.toolCalls, 0),
    tokens: runs.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0),
    freshTokens: runs.reduce((sum, item) => sum + (item.usage?.input ?? 0) + (item.usage?.output ?? 0), 0),
    cacheReadTokens: runs.reduce((sum, item) => sum + (item.usage?.cacheRead ?? 0), 0),
    prompt: coordinator?.prompt ?? null,
    firstResponseMs: runs.some(run => run.firstResponseMs !== undefined) ? Math.max(...runs.map(run => run.firstResponseMs ?? 0)) : null,
    contextBytes: stepContexts.length ? Math.max(...stepContexts.map(item => item.taskContextBytes)) : 0,
    pauses,
    models: [...new Set(runs.map(item => item.model))],
    lastFailure: ledger.lastFailure ?? null, timedOut, plan,
  };
  console.log(`${passed ? "PASS" : "FAIL"} ${task.id}: alpha ${ledger.status}, ${result.detail.split("\n")[0]} (${Math.round(result.wallMs / 1000)}s, ${result.toolCalls} tool calls, ${result.tokens} tokens; plans ${plan.plans}/rev ${plan.revisions}/rework ${plan.reworkReopens}/premise ${plan.premiseReopens}/redo ${plan.redoReopens}/cr ${plan.changesRequested})`);
  return result;
}

function summary(results: TaskResult[]) {
  const passed = results.filter(item => item.passed).length;
  const accepted = results.filter(item => item.alphaStatus === "complete").length;
  return {
    tasks: results.length, passed, passRate: results.length ? passed / results.length : 0,
    alphaAccepted: accepted, falseAcceptances: results.filter(item => item.falseAcceptance).length,
    missedAcceptances: results.filter(item => item.passed && item.alphaStatus !== "complete").length,
    tokens: results.reduce((sum, item) => sum + item.tokens, 0),
    toolCalls: results.reduce((sum, item) => sum + item.toolCalls, 0),
    wallMinutes: Math.round(results.reduce((sum, item) => sum + item.wallMs, 0) / 60_000),
  };
}

function report(label: string, app: string, results: TaskResult[]): string {
  const total = summary(results);
  const planCell = (item: TaskResult) => {
    const plan = item.plan;
    if (!plan.plans && !plan.revisions && !plan.reworkReopens && !plan.premiseReopens && !plan.redoReopens && !plan.changesRequested) return "—";
    return `计划 ${plan.plans}/修订 ${plan.revisions} · 回边 rework ${plan.reworkReopens} premise ${plan.premiseReopens} redo ${plan.redoReopens} · 退审 ${plan.changesRequested}`;
  };
  const rows = results.map(item => `| ${item.id} | ${item.passed ? "✅" : "❌"} | ${item.alphaStatus}${item.falseAcceptance ? " ⚠️" : ""} | ${Math.round(item.wallMs / 1000)}s | ${item.runs} | ${item.toolCalls} | ${item.freshTokens.toLocaleString()} + ${item.cacheReadTokens.toLocaleString()} | ${item.prompt ? `${item.prompt.systemTokens} + ${item.prompt.toolTokens}` : "—"} | ${item.contextBytes ? `${Math.round(item.contextBytes / 102.4) / 10}k` : "—"} | ${item.firstResponseMs === null ? "—" : `${Math.round(item.firstResponseMs / 100) / 10}s`} | ${item.pauses ? `${item.pauses} 次` : "—"} | ${planCell(item)} | ${item.detail.split("\n")[0].replace(/\|/g, "\\|").slice(0, 120)} |`);
  return [
    `# Alpha 评测：${label}`, "",
    `- 被测代码：\`${app}\``, `- 时间：${new Date().toISOString()}`,
    `- 通过：${total.passed}/${total.tasks}；Alpha 自评已验收 ${total.alphaAccepted}；自评通过但独立检查失败 ${total.falseAcceptances}；独立检查通过但自评未验收 ${total.missedAcceptances}`,
    `- 合计：${total.toolCalls} 次工具调用，${total.tokens.toLocaleString()} tokens（新输入+输出 ${results.reduce((sum, item) => sum + item.freshTokens, 0).toLocaleString()}，缓存读 ${results.reduce((sum, item) => sum + item.cacheReadTokens, 0).toLocaleString()}），${total.wallMinutes} 分钟（各任务耗时之和）`, "",
    "| 任务 | 独立检查 | Alpha 状态 | 耗时 | 轮次 | 工具调用 | tokens（新输入+输出 + 缓存读） | 固定提示词（系统 + 工具） | 每步上下文 | 首响应 | 恢复 | 计划图 | 说明 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows, "",
  ].join("\n");
}

async function compare(a: string, b: string): Promise<void> {
  const load = async (dir: string) => JSON.parse(await readFile(join(dir, "results.json"), "utf8")) as { label: string; results: TaskResult[] };
  const [left, right] = await Promise.all([load(a), load(b)]);
  const ids = [...new Set([...left.results, ...right.results].map(item => item.id))].sort();
  const cell = (item?: TaskResult) => item ? `${item.passed ? "✅" : "❌"} ${item.alphaStatus} · ${Math.round(item.wallMs / 1000)}s · ${item.toolCalls} 调用 · ${item.tokens.toLocaleString()} tok` : "—";
  const lines = [
    `| 任务 | ${left.label} | ${right.label} |`, "|---|---|---|",
    ...ids.map(id => `| ${id} | ${cell(left.results.find(item => item.id === id))} | ${cell(right.results.find(item => item.id === id))} |`),
  ];
  for (const side of [left, right]) {
    const total = summary(side.results);
    lines.push("", `**${side.label}**：通过 ${total.passed}/${total.tasks}，误判验收 ${total.falseAcceptances}，漏判 ${total.missedAcceptances}，${total.toolCalls} 次调用，${total.tokens.toLocaleString()} tokens，${total.wallMinutes} 分钟`);
  }
  console.log(lines.join("\n"));
}

if (process.argv[2] === "compare") {
  await compare(process.argv[3], process.argv[4]);
  process.exit(0);
}
const tasks = await loadTasks(option("tasks"));
if (process.argv.includes("--selfcheck")) process.exit(await selfcheck(tasks) ? 0 : 1);

const app = resolve(option("app") ?? repo);
const label = option("label") ?? "current";
const concurrency = Math.max(1, Number(option("concurrency") ?? 1));
const timeoutMs = Number(option("timeout-min") ?? 25) * 60_000;
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const out = resolve(option("out") ?? join(repo, "artifacts", `eval-${today}-${label}`));
// A round must never silently overwrite another round's record: a label that already holds results needs --force
// (this is how the P0 baseline lost round 2).
if (!process.argv.includes("--force") && await Bun.file(join(out, "results.json")).exists()) {
  console.error(`评测目录已有结果：${out}\n换一个 --label，或加 --force 覆盖。`);
  process.exit(2);
}
await mkdir(out, { recursive: true });
const revision = (await run(["git", "rev-parse", "HEAD"], repo)).output.trim();
const workspace = await prepareWorkspace(label);
// --model <provider>/<id> runs the round on another provider (default: the workspace settings' own default).
const modelOption = option("model");
if (modelOption) {
  const settingsPath = join(workspace, ".alpha", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { model?: { default?: string | null; providers?: string[] } };
  settings.model = { ...settings.model, default: modelOption, providers: [...new Set([...(settings.model?.providers ?? []), modelOption.split("/")[0]])] };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`model override: ${modelOption}`);
}
const server = await startServer(app, workspace);
console.log(`Alpha (${label}) at ${server.base}, workspace ${workspace}`);
const results: TaskResult[] = [];
const queue = [...tasks];
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift()!;
      try { results.push(await runTask(server.base, workspace, task, timeoutMs)); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.log(`ERROR ${task.id}: ${detail}`);
        results.push({ id: task.id, kind: task.kind, alphaStatus: "error", passed: false, falseAcceptance: false, detail, wallMs: 0, runs: 0, toolCalls: 0, tokens: 0, freshTokens: 0, cacheReadTokens: 0, prompt: null, firstResponseMs: null, contextBytes: 0, pauses: 0, models: [], lastFailure: null, timedOut: false, plan: { plans: 0, revisions: 0, reworkReopens: 0, premiseReopens: 0, redoReopens: 0, changesRequested: 0 } });
      }
      await writeFile(join(out, "results.json"), JSON.stringify({ label, app, workspace, results }, null, 2));
    }
  }));
} finally { await server.stop(); }
results.sort((a, b) => a.id.localeCompare(b.id));
await writeFile(join(out, "results.json"), JSON.stringify({ label, app, workspace, revision, model: modelOption ?? null, results }, null, 2));
await writeFile(join(out, "report.md"), report(label, app, results));
console.log(`\n${report(label, app, results)}\nResults: ${out}`);
process.exit(0);
