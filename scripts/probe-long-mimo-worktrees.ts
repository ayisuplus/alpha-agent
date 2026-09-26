import { createHash, randomUUID } from "node:crypto";
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WorkerSupervisor } from "../src/runtime/worker-supervisor";
import { TaskLedger } from "../src/runtime/task-ledger";
import type { WorkOrder } from "../src/runtime/work-orders";

const model = "xiaomi-token-plan-cn/mimo-v2.6-flash";
const runId = randomUUID();
const root = resolve(import.meta.dir, "..", "artifacts", "mimo-long-20260926");
const runRoot = join(root, "managed-runs", runId);
const projectRoot = join(runRoot, "project");
const dataRoot = join(runRoot, "state");
const reportPath = join(runRoot, "report.json");
const testFiles = ["test/parse.test.ts", "test/reconcile.test.ts", "test/cli.test.ts", "test/fixtures/events.csv"];
const report: Record<string, unknown> = { model, runRoot, projectRoot, dataRoot, startedAt: new Date().toISOString(), stages: [] };
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

await mkdir(runRoot, { recursive: true });
await cp(join(root, "template"), projectRoot, { recursive: true });
const initialHashes = Object.fromEntries(await Promise.all(testFiles.map(async path => [path, hash(await readFile(join(projectRoot, path)))])));
report.initialTestHashes = initialHashes;
report.baseline = await command([process.execPath, "test", "./test"], projectRoot);
await save();
console.log(JSON.stringify({ phase: "baseline", code: (report.baseline as { code: number }).code, reportPath }));

const ledger = await TaskLedger.create(dataRoot, {
  objective: "Build and review an event-ledger CLI through parallel full-access worktree agents.",
  projectRoot, taskType: "code-change", startMode: "execute",
  workspaceOrigin: { kind: "copy", checks: [{ name: "test", command: "bun test ./test" }] },
  criteria: [{ id: "delivery", description: "CLI implementation and unchanged passing tests", kind: "test" }],
  modelSelector: model,
});
report.taskId = ledger.state.id;
report.ledgerPath = ledger.file;
await save();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("20-minute task budget")), 1_200_000);
const supervisor = new WorkerSupervisor({
  ledger, dataRoot, modelSelector: model, signal: controller.signal,
  remainingCalls: () => 400, remainingTimeMs: () => 1_200_000,
  onStatus: value => console.log(JSON.stringify({ phase: "status", value })),
});

async function stage(orders: WorkOrder[], checks: Record<string, string>) {
  const ids = await supervisor.spawn(orders);
  while (ids.some(id => ["queued", "running"].includes(ledger.state.cognition?.instances?.find(item => item.id === id)?.status ?? ""))) {
    const pending = ids.filter(id => ["queued", "running"].includes(ledger.state.cognition?.instances?.find(item => item.id === id)?.status ?? ""));
    await supervisor.wait(pending, 60_000, false);
  }
  const stages = report.stages as Array<Record<string, unknown>>;
  for (const item of orders) {
    const checked = await supervisor.inspect(item.instanceId!);
    const changes = checked.report?.changes[item.id] ?? [];
    const entry: Record<string, unknown> = {
      id: item.id, instanceId: item.instanceId, status: checked.instance.status,
      reportStatus: checked.report?.status, changes, findings: checked.report?.results[item.id]?.findings,
      reviewVerdict: checked.report?.results[item.id]?.reviewVerdict,
      diff: checked.diff?.slice(0, 12000) ?? "",
    };
    stages.push(entry);
    await save();
    if (checked.instance.status !== "returned" || checked.report?.status !== "ready") throw new Error(item.id + " did not return an integrable worktree");
    if (item.mode === "implement" && (changes.length !== 1 || changes[0] !== item.ownedPaths[0])) {
      throw new Error(item.id + " changed unexpected files: " + changes.join(", "));
    }
    if (checks[item.id]) {
      entry.check = await command([process.execPath, "test", checks[item.id]], join(checked.report.workRoot, item.id));
      await save();
      if ((entry.check as { code: number }).code !== 0) throw new Error(item.id + " focused tests failed");
    }
  }
  for (const item of orders) {
    const result = await supervisor.integrate(item.instanceId!);
    stages.find(entry => entry.instanceId === item.instanceId)!.integration = result.status;
    await save();
  }
}

let error: string | null = null;
try {
  await stage([
    order("parse",
      "Implement only src/parse.ts for the existing test/parse.test.ts and src/contracts.ts contract. Handle quoted CSV fields, CRLF, blank trailing rows, strict header, required cells and integer cents. Do not edit tests or other source. Do not invoke alpha_command or unconfigured commands. You may run the configured alpha_check script named test; unrelated suites will fail until the parent integrates other workers. Submit alpha_worker_result completed with concrete findings.",
      ["src/parse.ts"], ["src/contracts.ts", "test/parse.test.ts"]),
    order("reconcile",
      "Implement only src/reconcile.ts for the existing test/reconcile.test.ts and src/contracts.ts contract. Sum by account, sort account IDs, deduplicate identical event IDs, reject conflicting repeated IDs including changed timestamps, and leave inputs untouched. Do not edit tests or other source. Do not invoke alpha_command or unconfigured commands. You may run the configured alpha_check script named test; unrelated suites will fail until the parent integrates other workers. Submit alpha_worker_result completed with concrete findings.",
      ["src/reconcile.ts"], ["src/contracts.ts", "test/reconcile.test.ts"]),
  ], { parse: "test/parse.test.ts", reconcile: "test/reconcile.test.ts" });
  await stage([
    order("cli",
      "Implement only src/cli.ts. summarizeCsv must compose parseEvents and reconcileEvents and return JSON; the command-line entrypoint must read the CSV path from Bun.argv[2] and print the same JSON. Preserve all tests and other source. Run the configured alpha_check script named test, never alpha_command. Submit alpha_worker_result completed with actual test evidence.",
      ["src/cli.ts"], ["src/contracts.ts", "src/parse.ts", "src/reconcile.ts", "test/cli.test.ts"]),
  ], { cli: "./test" });
  await stage([
    order("review",
      "Independently review the completed event-ledger CLI against all tests and source. Run alpha_check script test. Do not invoke alpha_command. If correct, submit alpha_worker_result status completed, reviewVerdict pass, and reviewEvidence with a current source excerpt at least 20 characters long. If a defect remains, report changes-requested with exact findings. Do not change tests.",
      [], ["src/cli.ts", "src/parse.ts", "src/reconcile.ts", "test"], "review"),
  ], { review: "./test" });
} catch (cause) {
  error = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  await supervisor.cancelExecuting();
} finally {
  clearTimeout(timeout);
}
const finalTest = await command([process.execPath, "test", "./test"], projectRoot);
const finalHashes = Object.fromEntries(await Promise.all(testFiles.map(async path => [path, hash(await readFile(join(projectRoot, path)))])));
report.finishedAt = new Date().toISOString();
report.error = error;
report.finalTest = finalTest;
report.testsUnchanged = testFiles.every(path => initialHashes[path] === finalHashes[path]);
report.instances = (ledger.state.cognition?.instances ?? []).map(item => ({ id: item.id, orderId: item.orderId, status: item.status }));
report.worktrees = await command(["git", "worktree", "list", "--porcelain"], projectRoot);
report.success = !error && finalTest.code === 0 && report.testsUnchanged
  && (report.stages as Array<Record<string, unknown>>).some(item => item.id === "review" && item.reviewVerdict === "pass");
await save();
console.log(JSON.stringify({ phase: "done", success: report.success, finalTestCode: finalTest.code, error, reportPath }));
if (!report.success) process.exitCode = 1;
