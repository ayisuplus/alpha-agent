import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkerSupervisor } from "../src/runtime/worker-supervisor";
import { TaskLedger } from "../src/runtime/task-ledger";
import type { WorkOrder } from "../src/runtime/work-orders";

const model = "xiaomi-token-plan-cn/mimo-v2.6-flash";
const runRoot = resolve(Bun.argv[2] ?? "");
if (!Bun.argv[2]) throw new Error("Pass the existing managed run directory");
const reportPath = join(runRoot, "report.json");
const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
const projectRoot = report.projectRoot as string;
const dataRoot = report.dataRoot as string;
const ledger = await TaskLedger.load(report.ledgerPath as string);
const testFiles = ["test/parse.test.ts", "test/reconcile.test.ts", "test/cli.test.ts", "test/fixtures/events.csv"];
const initialHashes = report.initialTestHashes as Record<string, string>;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2));
const command = async (args: string[], cwd: string) => {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: (stdout + "\n" + stderr).slice(-6000) };
};
const order = (id: string, objective: string, ownedPaths: string[], readPaths: string[], mode: "implement" | "review" = "implement"): WorkOrder => ({
  id, instanceId: randomUUID(), objective, ownedPaths, readPaths, resources: [id], mode, fullAccess: true,
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("20-minute continuation budget")), 1_200_000);
const supervisor = new WorkerSupervisor({
  ledger, dataRoot, modelSelector: model, signal: controller.signal,
  remainingCalls: () => 400, remainingTimeMs: () => 1_200_000,
  onStatus: value => console.log(JSON.stringify({ phase: "status", value })),
});

async function stage(item: WorkOrder, testPath: string) {
  const [id] = await supervisor.spawn([item]);
  while (["queued", "running"].includes(ledger.state.cognition?.instances?.find(instance => instance.id === id)?.status ?? "")) {
    await supervisor.wait([id], 60_000, false);
  }
  const checked = await supervisor.inspect(id);
  const changes = checked.report?.changes[item.id] ?? [];
  const entry: Record<string, unknown> = {
    id: item.id, instanceId: id, status: checked.instance.status,
    reportStatus: checked.report?.status, changes, findings: checked.report?.results[item.id]?.findings,
    reviewVerdict: checked.report?.results[item.id]?.reviewVerdict,
    diff: checked.diff?.slice(0, 12000) ?? "",
  };
  (report.stages as Array<Record<string, unknown>>).push(entry);
  await save();
  if (checked.instance.status !== "returned" || checked.report?.status !== "ready") throw new Error(item.id + " did not return an integrable worktree");
  if (item.mode === "implement" && (changes.length !== 1 || changes[0] !== item.ownedPaths[0])) throw new Error(item.id + " changed unexpected files: " + changes.join(", "));
  entry.check = await command([process.execPath, "test", testPath], join(checked.report.workRoot, item.id));
  await save();
  if ((entry.check as { code: number }).code !== 0) throw new Error(item.id + " tests failed");
  const integrated = await supervisor.integrate(id);
  entry.integration = integrated.status;
  await save();
}

let error: string | null = null;
try {
  const stale = ledger.state.cognition?.instances?.find(item => item.orderId === "reconcile" && item.status === "returned");
  if (stale) await supervisor.cancel(stale.id);
  await stage(order("reconcile_retry",
    "Implement only src/reconcile.ts for test/reconcile.test.ts. Sum by account, sort IDs, skip exact duplicate event IDs, reject conflicting repeated IDs including changed timestamps, and do not mutate input. The parser is already implemented in the parent. Read only src/contracts.ts, src/reconcile.ts and test/reconcile.test.ts; do not edit any other file. Do not invoke alpha_command. Parent will run focused tests, so return alpha_worker_result completed after implementation.",
    ["src/reconcile.ts"], ["src/contracts.ts", "test/reconcile.test.ts"]), "test/reconcile.test.ts");
  await stage(order("cli",
    "Implement only src/cli.ts. summarizeCsv must compose parseEvents and reconcileEvents and return JSON; command-line entrypoint reads the CSV path from Bun.argv[2] and prints the same JSON. Preserve all tests and other source. Use alpha_check script test for verification; never alpha_command. Submit alpha_worker_result completed with actual evidence.",
    ["src/cli.ts"], ["src/contracts.ts", "src/parse.ts", "src/reconcile.ts", "test/cli.test.ts"]), "./test");
  await stage(order("review",
    "Independently inspect the completed event-ledger CLI and all existing tests. Run alpha_check script test; never alpha_command. If correct, submit alpha_worker_result completed with reviewVerdict pass and reviewEvidence citing a current source excerpt at least 20 characters. If incorrect, report changes-requested with exact findings. Do not edit tests.",
    [], ["src/cli.ts", "src/parse.ts", "src/reconcile.ts", "test"], "review"), "./test");
} catch (cause) {
  error = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  await supervisor.cancelExecuting();
} finally {
  clearTimeout(timeout);
}
const finalTest = await command([process.execPath, "test", "./test"], projectRoot);
const finalHashes = Object.fromEntries(await Promise.all(testFiles.map(async path => [path, hash(await readFile(join(projectRoot, path)))])));
report.continuedAt = new Date().toISOString();
report.error = error;
report.finalTest = finalTest;
report.testsUnchanged = testFiles.every(path => initialHashes[path] === finalHashes[path]);
report.instances = (ledger.state.cognition?.instances ?? []).map(item => ({ id: item.id, orderId: item.orderId, status: item.status }));
report.success = !error && finalTest.code === 0 && report.testsUnchanged
  && (report.stages as Array<Record<string, unknown>>).some(item => item.id === "review" && item.reviewVerdict === "pass");
await save();
console.log(JSON.stringify({ phase: "done", success: report.success, finalTestCode: finalTest.code, error, reportPath }));
if (!report.success) process.exitCode = 1;
