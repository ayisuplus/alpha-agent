import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGeneralWorkspace } from "../src/runtime/general-work";
import { DEFAULT_MODEL } from "../src/runtime/omp-runner";

const root = await mkdtemp(join(tmpdir(), "alpha-schedule-probe-"));
const productsRoot = join(root, "products");
await mkdir(productsRoot);
const objective = "Create a DOCX with title Scheduled Probe and one paragraph saying the scheduled run completed. Use alpha_document and write alpha-deliverable.json with the exact output path.";
const ledger = await createGeneralWorkspace({ taskType: "file-work", objective, productsRoot, dataRoot: join(root, ".alpha"), modelSelector: DEFAULT_MODEL });
const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "..", "src", "server.ts")], { cwd: root, env: { ...process.env, ALPHA_WORKSPACE_ROOT: root }, stdout: "pipe", stderr: "pipe" });
try {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("Server output unavailable");
  const reader = child.stdout.getReader();
  let output = "";
  let port: string | undefined;
  while (!port) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Server exited: ${output}`);
    output += new TextDecoder().decode(chunk.value);
    port = /ALPHA_SERVER_READY (\d+)/.exec(output)?.[1];
  }
  const base = `http://127.0.0.1:${port}`;
  const scheduleResponse = await fetch(`${base}/api/schedules`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ taskId: ledger.state.id, instruction: objective, nextRunAt: new Date(Date.now() + 1_000).toISOString(), intervalMinutes: null }) });
  if (!scheduleResponse.ok) throw new Error(`Schedule rejected: ${await scheduleResponse.text()}`);
  const deadline = Date.now() + 90_000;
  let completed = false;
  while (Date.now() < deadline) {
    await Bun.sleep(2_000);
    const queue = await fetch(`${base}/api/queue`).then(response => response.json()) as { items: Array<{ taskId: string; status: string; result?: string; scheduledFor?: string }> };
    const item = queue.items.find(value => value.taskId === ledger.state.id);
    if (item?.status === "complete" || item?.status === "failed") {
      const task = await fetch(`${base}/api/tasks/${ledger.state.id}`).then(response => response.json()) as { task: { status: string; evidence: unknown[] } };
      console.log(JSON.stringify({ root, taskId: ledger.state.id, queue: item, taskStatus: task.task.status, evidenceCount: task.task.evidence.length }));
      if (item.status !== "complete" || task.task.status !== "complete") throw new Error("Scheduled model task did not complete");
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error(`Scheduled task did not finish within 90 seconds; inspect ${root}`);
} finally { child.kill(); await child.exited; }
