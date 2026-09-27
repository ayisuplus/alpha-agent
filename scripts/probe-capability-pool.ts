import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL, runTask, type RunEvent } from "../src/runtime/omp-runner";
import { TaskLedger } from "../src/runtime/task-ledger";
import { WorkerSupervisor } from "../src/runtime/worker-supervisor";
import type { WorkOrder } from "../src/runtime/work-orders";

const root = resolve(".alpha", "probes", `capability-pool-${randomUUID()}`);
const reportPath = join(root, "report.json");
const report: Record<string, unknown> = { root, model: DEFAULT_MODEL, startedAt: new Date().toISOString() };
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const git = async (cwd: string, ...args: string[]) => {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (code) throw new Error(stderr);
};
const trace = (events: RunEvent[]) => (event: RunEvent) => {
  if (event.type === "tool-start" || event.type === "text") events.push({ ...event, value: event.value.slice(0, 400) });
};

await mkdir(root, { recursive: true });
try {
  const projectRoot = join(root, "project");
  const dataRoot = join(root, "state");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(join(projectRoot, "test"), { recursive: true });
  await mkdir(join(dataRoot, "plugin-packs", "sample", "skills", "proof"), { recursive: true });
  await writeFile(join(projectRoot, "src", "value.ts"), "export const value = 0;\n");
  await writeFile(join(projectRoot, "test", "value.test.ts"), 'import { test, expect } from "bun:test";\nimport { value } from "../src/value";\ntest("value", () => expect(value).toBe(42));\n');
  await writeFile(join(projectRoot, "package.json"), '{"name":"capability-probe","private":true,"scripts":{"test":"bun test test/value.test.ts"}}');
  await writeFile(join(dataRoot, "plugin-packs", "sample", "skills", "proof", "SKILL.md"), "---\nname: proof\ndescription: Update a tiny TypeScript value and verify the exact test\n---\n\nRead src/value.ts. Set the exported value to 42. Run the configured test and report its result.\n");
  await writeFile(join(dataRoot, "plugin-packs", "installed.json"), JSON.stringify({ plugins: [{ id: "sample", name: "sample", source: "https://github.com/example/sample.git", revision: "a".repeat(40), enabled: true, skillCount: 1, hookCount: 0, hooksEnabled: false, mcpCount: 0, mcpEnabled: false }] }));
  await git(projectRoot, "init");
  await git(projectRoot, "-c", "user.name=Alpha Probe", "-c", "user.email=alpha-probe@local", "add", ".");
  await git(projectRoot, "-c", "user.name=Alpha Probe", "-c", "user.email=alpha-probe@local", "commit", "-m", "Probe base");
  const ledger = await TaskLedger.create(dataRoot, { objective: "Coordinate the worker to update src/value.ts to 42 using the proof method and verify the configured test", projectRoot, taskType: "code-change", criteria: [{ id: "value", description: "Value is 42 and the configured test passes", kind: "test" }] });
  const supervisor = new WorkerSupervisor({ ledger, dataRoot, modelSelector: DEFAULT_MODEL, remainingCalls: () => 120, remainingTimeMs: () => 600_000, plugins: { comfyui: false } });
  const order: WorkOrder = { id: "change-value", agentId: randomUUID(), instanceId: randomUUID(), mode: "implement", fullAccess: true,
    objective: "The proof Skill is required for this order but has not been distributed. Before editing, report this capability gap immediately with alpha_send kind request and request.kind capability, blockedStep, capabilityIds [sample:proof], and evidence or an exact source excerpt. Wait for the coordinator to bind it. After continuation, read the Skill, update src/value.ts to 42, run the configured test, and submit a result.",
    decisionReason: "Exercise on-demand capability distribution", ownedPaths: ["src/value.ts"], readPaths: ["test/value.test.ts"], resources: ["value"], acceptance: ["The value test passes"], contractVersion: 1, baseRevision: ledger.state.revision ?? undefined };
  try {
    const [first] = await supervisor.spawn([order]);
    for (let i = 0; i < 180 && ["queued", "running"].includes(ledger.state.cognition?.instances?.find(item => item.id === first)?.status ?? ""); i++) await Bun.sleep(1_000);
    await supervisor.mailbox.collect();
    report.request = ledger.state.workerRequests?.[0];
    report.firstStatus = ledger.state.cognition?.instances?.find(item => item.id === first)?.status;
    await save();
    if (report.firstStatus !== "blocked" || !ledger.state.workerRequests?.some(item => item.kind === "capability" && item.capabilityIds.includes("sample:proof"))) throw new Error("Worker did not report the selected capability gap");
    const events: RunEvent[] = [];
    await runTask({ projectRoot, dataRoot, existingLedger: ledger, getWorkerSupervisor: () => supervisor,
      objective: `Use alpha_capability_search to find sample:proof. Read alpha_inbox, resolve request ${ledger.state.workerRequests[0].id} with alpha_worker_resolve action grant, capabilityIds [sample:proof], and a reason. After the request is resolved, stop this coordinator turn; do not wait or edit.`,
      modelSelector: DEFAULT_MODEL, maxToolCalls: 8, wallTimeMs: 180_000, signal: AbortSignal.timeout(180_000), plugins: { comfyui: false }, onEvent: trace(events) });
    const continuation = ledger.state.workerRequests?.[0].resolutionRunId;
    if (!continuation) throw new Error("Coordinator did not continue the original worker");
    for (let i = 0; i < 500 && ["queued", "running"].includes(ledger.state.cognition?.instances?.find(item => item.id === continuation)?.status ?? ""); i++) await Bun.sleep(1_000);
    const worker = ledger.state.cognition?.instances?.find(item => item.id === continuation);
    if (worker?.status !== "returned") throw new Error(`Continued worker did not return a reviewable result: ${worker?.status ?? "missing"}`);
    await runTask({ projectRoot, dataRoot, existingLedger: ledger, getWorkerSupervisor: () => supervisor,
      objective: `Use alpha_inspect on returned worker ${continuation}. Its configured alpha_check test already passed in the worker and has a receipt; read that result and the actual src/value.ts diff. If the change matches the work order, use alpha_integrate with a reason. Do not call alpha_command, rerun tests, edit source, or claim final task completion. This turn is only for checking and integrating the returned work.`,
      modelSelector: DEFAULT_MODEL, maxToolCalls: 12, wallTimeMs: 180_000, signal: AbortSignal.timeout(180_000), plugins: { comfyui: false }, onEvent: trace(events) });
    report.coordinatorTools = events.filter(item => item.type === "tool-start").map(item => item.value);
    report.requestAfter = ledger.state.workerRequests?.[0];
    report.instances = ledger.state.cognition?.instances?.filter(item => item.agentId === order.agentId).map(item => ({ id: item.id, status: item.status, skills: item.skills, integration: item.integration }));
    report.source = await Bun.file(join(projectRoot, "src", "value.ts")).text();
    report.acceptanceGaps = ledger.completionGaps();
    const testProcess = Bun.spawn([process.execPath, "run", "test"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
    const [testOutput, testError, testCode] = await Promise.all([new Response(testProcess.stdout).text(), new Response(testProcess.stderr).text(), testProcess.exited]);
    report.test = { exitCode: testCode, output: `${testOutput}\n${testError}`.slice(-1000) };
    if (!report.coordinatorTools || !(report.coordinatorTools as string[]).includes("alpha_capability_search") || !(report.coordinatorTools as string[]).includes("alpha_worker_resolve") || ledger.state.workerRequests?.[0].status !== "applied" || !ledger.state.cognition?.agents?.some(item => item.id === order.agentId && item.contextRevision === 2 && item.skillIds.includes("sample:proof")) || !ledger.state.cognition?.instances?.some(item => item.agentId === order.agentId && item.status === "completed" && item.integration === "merged") || !String(report.source).includes("value = 42") || testCode !== 0) throw new Error("Capability handoff did not reach an integrated, tested result");
    report.success = true;
  } finally { await supervisor.cancelExecuting(); }
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ success: report.success, reportPath, request: report.request, requestAfter: report.requestAfter, firstStatus: report.firstStatus, coordinatorTools: report.coordinatorTools, instances: report.instances, source: report.source, test: report.test, acceptanceGaps: report.acceptanceGaps, error: report.error }));
}
