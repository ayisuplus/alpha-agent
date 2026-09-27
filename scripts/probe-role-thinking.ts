import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL, runTask, type RunEvent } from "../src/runtime/omp-runner";
import { TaskLedger } from "../src/runtime/task-ledger";
import { WorkerSupervisor } from "../src/runtime/worker-supervisor";
import type { WorkOrder } from "../src/runtime/work-orders";

const root = resolve(".alpha", "probes", `role-thinking-${randomUUID()}`);
const reportPath = join(root, "report.json");
const report: Record<string, unknown> = { model: DEFAULT_MODEL, root, startedAt: new Date().toISOString() };
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const command = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.slice(-500)}`);
};
const trace = (events: RunEvent[]) => (event: RunEvent) => {
  if (event.type === "tool-start" || event.type === "text") events.push({ ...event, value: event.value.slice(0, 500) });
};

await mkdir(root, { recursive: true });
try {
  const directProject = join(root, "direct-project");
  const directState = join(root, "direct-state");
  await mkdir(directProject);
  const direct = await TaskLedger.create(directState, { objective: "Answer 2 + 2 in one sentence. No files or delegation are needed.", projectRoot: directProject, taskType: "general", criteria: [] });
  const directEvents: RunEvent[] = [];
  const directResult = await runTask({ projectRoot: directProject, dataRoot: directState, objective: direct.state.objective, existingLedger: direct, modelSelector: DEFAULT_MODEL, maxToolCalls: 6, wallTimeMs: 90_000, signal: AbortSignal.timeout(90_000), plugins: { comfyui: false }, onEvent: trace(directEvents) });
  report.direct = { status: directResult.state.status, tools: directEvents.filter(item => item.type === "tool-start").map(item => item.value), text: directEvents.filter(item => item.type === "text").map(item => item.value).join(" ").slice(-600), policyVersion: directResult.state.runs?.at(-1)?.thinkingPolicyVersion };
  await save();
  if (directResult.state.status !== "active" || directEvents.some(item => item.type === "tool-start" && item.value === "alpha_spawn")) throw new Error("Direct coordinator probe failed");

  const projectRoot = join(root, "worker-project");
  const dataRoot = join(root, "worker-state");
  await mkdir(join(projectRoot, "docs"), { recursive: true });
  await writeFile(join(projectRoot, "docs", "source.txt"), "The configured source is actual, not legacy.\n");
  await command(projectRoot, "git", "init");
  await command(projectRoot, "git", "-c", "user.name=Alpha Probe", "-c", "user.email=alpha-probe@local", "add", ".");
  await command(projectRoot, "git", "-c", "user.name=Alpha Probe", "-c", "user.email=alpha-probe@local", "commit", "-m", "Probe base");
  const parent = await TaskLedger.create(dataRoot, { objective: "Update the documented source after verifying the legacy-source premise", projectRoot, taskType: "code-change", criteria: [{ id: "source", description: "Correct source documented and verified", kind: "asset" }] });
  const workerAbort = AbortSignal.timeout(180_000);
  const supervisor = new WorkerSupervisor({ ledger: parent, dataRoot, modelSelector: DEFAULT_MODEL, signal: workerAbort, remainingCalls: () => 120, remainingTimeMs: () => 600_000 });
  const order: WorkOrder = {
    id: "inspect-source", agentId: randomUUID(), instanceId: randomUUID(), mode: "investigate", fullAccess: true,
    objective: "The task assumes docs/source.txt says the source is legacy. Read the file and verify this premise before any implementation. If it is false, use alpha_send kind request with sourceEvidence containing an exact 20+ character excerpt and a recommendation to revise the plan. The request hands the run back to the coordinator. Do not edit source.",
    decisionReason: "Verify a critical premise before implementing the source change", ownedPaths: [], readPaths: ["docs/source.txt"], resources: ["source-premise"], acceptance: ["Report the verified source and its effect on the task"], contractVersion: 1, baseRevision: parent.state.revision ?? undefined,
  };
  try {
    const [id] = await supervisor.spawn([order]);
    for (let i = 0; i < 150 && ["queued", "running"].includes(parent.state.cognition?.instances?.find(item => item.id === id)?.status ?? ""); i++) await Bun.sleep(1_000);
    await supervisor.mailbox.collect();
    const messages = await supervisor.mailbox.inbox();
    const instance = parent.state.cognition?.instances?.find(item => item.id === id);
    report.worker = { status: instance?.status, decisionReason: instance?.decisionReason, messages: messages.filter(item => item.fromRunId === id).map(item => ({ kind: item.kind, body: item.body, sourceEvidence: item.sourceEvidence, recommendation: item.recommendation, sourceRevision: item.sourceRevision })), policyVersion: parent.state.runs?.find(item => item.instanceId === id)?.thinkingPolicyVersion };
    await save();
    if (instance?.status !== "blocked" || !messages.some(item => item.fromRunId === id && item.kind === "request" && item.sourceEvidence?.some(source => source.path === "docs/source.txt" && source.excerpt.includes("actual, not legacy")))) throw new Error("Worker did not escalate the false premise with current source evidence");

    const coordinatorEvents: RunEvent[] = [];
    await runTask({ projectRoot, dataRoot, existingLedger: parent, getWorkerSupervisor: () => supervisor, objective: "Read the pending worker message. Verify the reported source evidence, revise the task plan with alpha_plan to use the actual source, and leave final acceptance pending until there is current verification evidence. Do not edit files.", modelSelector: DEFAULT_MODEL, maxToolCalls: 12, wallTimeMs: 240_000, signal: AbortSignal.timeout(240_000), plugins: { comfyui: false }, onEvent: trace(coordinatorEvents) });
    report.coordinator = { tools: coordinatorEvents.filter(item => item.type === "tool-start").map(item => item.value), plan: parent.state.cognition?.summary, amendments: parent.state.cognition?.amendments, acceptanceGaps: parent.completionGaps(), status: parent.state.status, policyVersion: parent.state.runs?.at(-1)?.thinkingPolicyVersion };
    await save();
    if (!coordinatorEvents.some(item => item.type === "tool-start" && item.value === "alpha_inbox") || !coordinatorEvents.some(item => item.type === "tool-start" && item.value === "alpha_plan") || !/actual|实际/i.test(parent.state.cognition?.summary ?? "") || !parent.completionGaps().includes("source") || parent.state.status === "complete") throw new Error("Coordinator did not revise the plan and preserve the acceptance gap");
  } finally { await supervisor.cancelExecuting(); }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ success: report.success, reportPath, direct: report.direct, worker: report.worker, coordinator: report.coordinator, error: report.error }));
}
