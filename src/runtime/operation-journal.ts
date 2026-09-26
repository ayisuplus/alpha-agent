import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskLedger } from "./task-ledger";
import { recoverIncompleteMerges } from "./work-orders";
import { commandApprovalStore } from "./command-approval";
import { MCPPermissionStore } from "./mcp-permissions";

interface JournalEntry { taskId: string; runId: string; startedAt: string; status: "running" | "finished"; finishedAt?: string }

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
  async start(taskId: string, runId: string): Promise<void> {
    const file = this.file(taskId);
    const prior = await readFile(file, "utf8").then(value => JSON.parse(value) as JournalEntry).catch(() => null);
    if (prior?.status === "running" && prior.runId === runId) return;
    if (prior?.status === "running") throw new Error("Task has an unreconciled operation");
    await this.save({ taskId, runId, status: "running", startedAt: new Date().toISOString() });
  }
  async finish(taskId: string, runId: string): Promise<void> {
    const entry = await readFile(this.file(taskId), "utf8").then(value => JSON.parse(value) as JournalEntry).catch(() => null);
    if (!entry || entry.runId !== runId || entry.status === "finished") return;
    entry.status = "finished";
    entry.finishedAt = new Date().toISOString();
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
        await ledger.reconcileRunningInstances("Interrupted operation was reconciled; inspect evidence before redispatch");
        if (ledger.state.status === "active") {
          await ledger.refreshRevision();
          await ledger.stop();
        }
        await this.finish(entry.taskId, entry.runId);
        results.push({ taskId: entry.taskId, result: "stopped-after-reconcile" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await ledger.reconcileRunningInstances(`Recovery conflict: ${reason}`);
        if (ledger.state.status === "active") await ledger.needInput(`重启后动作对账发现冲突：${reason}。请审阅现场后再恢复。`, "recovery");
        await this.finish(entry.taskId, entry.runId);
        results.push({ taskId: entry.taskId, result: `conflict: ${reason}` });
      }
    }
    return results;
  }
}
