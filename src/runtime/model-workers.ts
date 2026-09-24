import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executeWorkOrders, type WorkBatchReport, type WorkOrder, type WorkerResult } from "./work-orders";

const appRoot = resolve(import.meta.dir, "..", "..");

export function runModelWorkOrders(input: {
  projectRoot: string;
  dataRoot: string;
  taskId: string;
  baseRevision: string;
  orders: WorkOrder[];
  signal?: AbortSignal;
  /** Workers run on the same model as the task that delegated to them. */
  modelSelector?: string;
  onWorkerEvent?: (order: WorkOrder, state: "started" | "completed" | "failed") => void;
}): Promise<WorkBatchReport> {
  return executeWorkOrders({ ...input, async runWorker(order, directory, signal) {
    signal?.throwIfAborted();
    const runDir = join(input.dataRoot, "worker-runs", input.taskId, `${order.id}-${randomUUID()}`);
    await mkdir(runDir, { recursive: true });
    const requestFile = join(runDir, "request.json");
    const resultFile = join(runDir, "result.json");
    const { preset, ...workOrder } = order;
    await writeFile(requestFile, JSON.stringify({ projectRoot: directory, dataRoot: join(runDir, "state"), objective: order.objective, workOrder, workerPreset: preset, modelSelector: input.modelSelector }));
    input.onWorkerEvent?.(order, "started");
    const child = Bun.spawn([process.execPath, "run", join(appRoot, "scripts", "run-worker.ts"), requestFile, resultFile], {
      cwd: appRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 125_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const result = await readFile(resultFile, "utf8").then(text => JSON.parse(text) as WorkerResult & { error?: string }).catch(() => null);
      if (signal?.aborted) throw new Error(`Worker ${order.id} was cancelled`);
      if (exitCode !== 0 || result?.error || !result) throw new Error(result?.error || stderr.trim().slice(-2_000) || stdout.trim().slice(-2_000) || `Worker ${order.id} exited ${exitCode}`);
      input.onWorkerEvent?.(order, "completed");
      return result;
    } catch (error) {
      input.onWorkerEvent?.(order, "failed");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  } });
}
