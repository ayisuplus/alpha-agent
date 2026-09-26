import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NeedsInputError, runTask } from "../src/runtime/omp-runner";
import { hashSkillDirectory } from "../src/plugins/third-party";
import type { WorkOrder, WorkerResult } from "../src/runtime/work-orders";
import type { AgentPresetSnapshot } from "../src/runtime/agent-presets";
import type { TaskState } from "../src/runtime/task-ledger";

const [requestFile, resultFile] = Bun.argv.slice(2);
if (!requestFile || !resultFile) throw new Error("Worker request and result paths are required");
const request = JSON.parse(await readFile(requestFile, "utf8")) as { taskId?: string; projectRoot: string; dataRoot: string; authorizationRoot?: string; workerContext?: Pick<TaskState, "taskType" | "workspaceOrigin" | "capabilities" | "permissionMode">; objective: string; workOrder: WorkOrder; workerPreset?: AgentPresetSnapshot; modelSelector?: string; eventFile?: string; plugins?: { comfyui: boolean }; generation?: { image: boolean; voice: boolean; video: boolean }; comfyUrl?: string };
const controller = new AbortController();
let eventSequence = 0;
let eventWrites: Promise<unknown> = Promise.resolve();
const readPaths = new Set<string>();
process.once("SIGINT", () => controller.abort());
try {
  for (const skill of request.workOrder.skillSnapshots ?? []) {
    const separator = skill.id.indexOf(":");
    if (separator < 1 || !/^[a-z][a-z0-9-]*$/.test(skill.id.slice(0, separator)) || !/^[a-z][a-z0-9-]*$/.test(skill.id.slice(separator + 1))) throw new Error("Worker Skill identifier is invalid");
    const directory = join(request.dataRoot, "plugin-packs", skill.id.slice(0, separator), "skills", skill.id.slice(separator + 1));
    if (await hashSkillDirectory(directory) !== skill.hash) throw new Error(`Worker Skill snapshot changed: ${skill.id}`);
  }
  const ledger = await runTask({
    ...request,
    signal: controller.signal,
    maxToolCalls: 40,
    wallTimeMs: 120_000,
    onWorkerRead: path => readPaths.add(path),
    onEvent(event) {
      if (!request.eventFile) return;
      const item = { taskId: request.taskId, instanceId: request.workOrder.instanceId, orderId: request.workOrder.id, sequence: ++eventSequence, ...event };
      eventWrites = eventWrites.then(() => appendFile(request.eventFile!, `${JSON.stringify(item)}\n`));
    },
  });
  await eventWrites;
  const run = ledger.state.runs?.at(-1);
  if (!ledger.state.workerOutcome) throw new Error("Worker did not submit alpha_worker_result");
  const result: WorkerResult = {
    ...ledger.state.workerOutcome,
    evidence: [ledger.file],
    readPaths: [...readPaths].sort(),
    unresolved: ledger.state.status === "active" ? ledger.state.workerOutcome.status === "completed" ? [] : ledger.state.workerOutcome.findings : [`Worker ended ${ledger.state.status}`],
    usage: run ? { model: run.model, toolCalls: run.toolCalls, elapsedMs: run.elapsedMs, tokens: run.usage, outcome: run.outcome } : undefined,
  };
  await writeFile(resultFile, JSON.stringify(result));
} catch (error) {
  await eventWrites.catch(() => undefined);
  const names = await readdir(join(request.dataRoot, "tasks")).catch(() => [] as string[]);
  const recent = await Promise.all(names.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => readFile(join(request.dataRoot, "tasks", name), "utf8").then(text => JSON.parse(text) as { status?: string; pendingQuestion?: string; runs?: Array<{ model: string; toolCalls: number; elapsedMs: number; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }; outcome: "returned" | "cancelled" | "budget" | "error" | "needs-input" }> }).catch(() => null)));
  const run = recent.flatMap(item => item?.runs ?? []).at(-1);
  const waiting = recent.find(item => item?.status === "needs-input");
  if (error instanceof NeedsInputError && waiting) {
    const reason = waiting.pendingQuestion ?? error.message;
    await writeFile(resultFile, JSON.stringify({ status: "needs-context", findings: [reason], evidence: [], unresolved: [reason], readPaths: [...readPaths].sort(), usage: run ? { model: run.model, toolCalls: run.toolCalls, elapsedMs: run.elapsedMs, tokens: run.usage, outcome: run.outcome } : undefined }));
  } else {
    await writeFile(resultFile, JSON.stringify({ error: error instanceof Error ? error.message : String(error), usage: run ? { model: run.model, toolCalls: run.toolCalls, elapsedMs: run.elapsedMs, tokens: run.usage, outcome: run.outcome } : undefined }));
    process.exitCode = 1;
  }
}
