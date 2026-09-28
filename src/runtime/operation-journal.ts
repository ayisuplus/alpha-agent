import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskLedger } from "./task-ledger";
import { recoverIncompleteMerges } from "./work-orders";
import { commandApprovalStore } from "./command-approval";
import { MCPPermissionStore } from "./mcp-permissions";

/** One operation latch per task; `format`/`version` let a reader tell which layout it is looking at. */
interface JournalEntry { taskId: string; runId: string; startedAt: string; status: "running" | "finished"; finishedAt?: string; format?: string; version?: number }

/**
 * A hard kill of the server leaves subagent children running: nothing holds their handle any more. The pid is in the
 * task log (`worker/activated`), so recovery can reap it — but only after confirming the process still is one of our
 * workers, because a pid can be reused by an unrelated program.
 */
async function isWorkerProcess(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    const probe = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { stdout: "pipe", stderr: "ignore" });
    const listed = await new Response(probe.stdout).text();
    return /^"[^"]*\bbun(\.exe)?"/i.test(listed.trim());
  }
  const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  return cmdline.includes("run-worker.ts");
}

export async function reapOrphanWorkers(ledger: TaskLedger): Promise<string[]> {
  const reaped: string[] = [];
  for (const instance of ledger.state.cognition?.instances ?? []) {
    if (!instance.pid || !["queued", "running"].includes(instance.status)) continue;
    if (!await isWorkerProcess(instance.pid)) continue;
    // Hard kill: the parent that could clean up is already gone, and Windows ignores SIGTERM for these children.
    try { process.kill(instance.pid, "SIGKILL"); reaped.push(`${instance.orderId}:${instance.pid}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  if (reaped.length) console.error("ALPHA_ORPHAN_WORKERS_REAPED", reaped.join(", "));
  return reaped;
}

export class OperationJournal {
  constructor(private readonly dataRoot: string) {}
  private file(taskId: string) { return join(this.dataRoot, "operation-journal", `${taskId}.json`); }
  private async save(entry: JournalEntry) {
    const file = this.file(entry.taskId);
    await mkdir(join(this.dataRoot, "operation-journal"), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(entry, null, 2));
    await rename(temp, file);
  }
  async start(taskId: string, runId: string, ledger?: TaskLedger | null): Promise<void> {
    const file = this.file(taskId);
    const prior = await readFile(file, "utf8").then(value => JSON.parse(value) as JournalEntry).catch(() => null);
    if (prior?.status === "running" && prior.runId === runId) return;
    if (prior?.status === "running") throw new Error("Task has an unreconciled operation");
    const startedAt = new Date().toISOString();
    // The event log is the source of truth; this file stays as the projection reconcile() and the scan read.
    if (ledger) await ledger.recordOperationStarted(runId, startedAt);
    await this.save({ taskId, runId, status: "running", startedAt, format: "operation-journal", version: 1 });
  }
  async finish(taskId: string, runId: string, ledger?: TaskLedger | null): Promise<void> {
    const entry = await readFile(this.file(taskId), "utf8").then(value => JSON.parse(value) as JournalEntry).catch(() => null);
    if (!entry || entry.runId !== runId || entry.status === "finished") return;
    entry.status = "finished";
    entry.finishedAt = new Date().toISOString();
    if (ledger) await ledger.recordOperationFinished(runId, entry.finishedAt);
    await this.save(entry);
  }
  async reconcile(): Promise<Array<{ taskId: string; result: string }>> {
    const directory = join(this.dataRoot, "operation-journal");
    const names = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
    const results: Array<{ taskId: string; result: string }> = [];
    for (const name of names) {
      const entry = JSON.parse(await readFile(join(directory, name), "utf8")) as JournalEntry;
      if (entry.status !== "running") continue;
      const ledger = await TaskLedger.load(join(this.dataRoot, "tasks", `${entry.taskId}.json`)).catch(() => null);
      if (!ledger) { results.push({ taskId: entry.taskId, result: "missing-ledger" }); continue; }
      try {
        await recoverIncompleteMerges(ledger.state.projectRoot, this.dataRoot, entry.taskId);
        await commandApprovalStore(this.dataRoot).reconcile(entry.taskId);
        await new MCPPermissionStore(this.dataRoot).reconcile(entry.taskId);
        const reaped = await reapOrphanWorkers(ledger);
        await ledger.reconcileRunningInstances("Interrupted operation was reconciled; inspect evidence before redispatch");
        if (ledger.state.status === "active") {
          await ledger.refreshRevision();
          await ledger.stop("reconciled", "Interrupted operation was reconciled");
        }
        await this.finish(entry.taskId, entry.runId);
        results.push({ taskId: entry.taskId, result: reaped.length ? `stopped-after-reconcile; reaped ${reaped.join(", ")}` : "stopped-after-reconcile" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await ledger.reconcileRunningInstances(`Recovery conflict: ${reason}`);
        if (ledger.state.status === "active") await ledger.needInput(`重启后动作对账发现冲突：${reason}。请审阅现场后再恢复。`, "project-state");
        await this.finish(entry.taskId, entry.runId);
        results.push({ taskId: entry.taskId, result: `conflict: ${reason}` });
      }
    }
    return results;
  }
}
