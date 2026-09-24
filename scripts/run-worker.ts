import { readFile, writeFile } from "node:fs/promises";
import { runTask } from "../src/runtime/omp-runner";
import type { WorkOrder, WorkerResult } from "../src/runtime/work-orders";

const [requestFile, resultFile] = Bun.argv.slice(2);
if (!requestFile || !resultFile) throw new Error("Worker request and result paths are required");
const request = JSON.parse(await readFile(requestFile, "utf8")) as { projectRoot: string; dataRoot: string; objective: string; workOrder: WorkOrder };
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
try {
  const ledger = await runTask({
    ...request,
    signal: controller.signal,
    maxToolCalls: 40,
    wallTimeMs: 120_000,
  });
  const run = ledger.state.runs?.at(-1);
  const result: WorkerResult = {
    evidence: [ledger.file],
    unresolved: ledger.state.status === "active" ? [] : [`Worker ended ${ledger.state.status}`],
    usage: run ? { model: run.model, toolCalls: run.toolCalls, elapsedMs: run.elapsedMs } : undefined,
  };
  await writeFile(resultFile, JSON.stringify(result));
} catch (error) {
  await writeFile(resultFile, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
