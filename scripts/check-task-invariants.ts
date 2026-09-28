// Runs the plan §4.6 invariants over existing task ledgers without touching them, and reports which ones are already
// violated. Run: bun run scripts/check-task-invariants.ts [--data .alpha] [--out artifacts/task-invariants.json]
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkTaskInvariants, UNCHECKABLE_INVARIANTS, type InvariantViolation, type TaskOperationRecord } from "../src/runtime/task-invariants";
import { readTaskState } from "../src/runtime/task-events";
import type { TaskState } from "../src/runtime/task-ledger";

const args = process.argv.slice(2);
const dataFlag = args.indexOf("--data");
const dataRoot = resolve(dataFlag >= 0 ? args[dataFlag + 1] : ".alpha");
const outFlag = args.indexOf("--out");
const outFile = outFlag >= 0 ? args[outFlag + 1] : `artifacts/task-invariants-${new Date().toISOString().slice(0, 10)}.json`;

interface TaskReport {
  id: string;
  file: string;
  status: TaskState["status"];
  phase: NonNullable<TaskState["phase"]> | null;
  taskType: NonNullable<TaskState["taskType"]> | null;
  contractVersion: number;
  pauseReason: TaskState["pauseReason"] | null;
  stopReason: NonNullable<TaskState["stop"]>["reason"] | null;
  evidence: number;
  runs: number;
  instances: number;
  violations: InvariantViolation[];
}

const operations: TaskOperationRecord[] = [];
for (const name of (await readdir(join(dataRoot, "operation-journal")).catch(() => [] as string[])).filter(name => name.endsWith(".json"))) {
  const entry = JSON.parse(await readFile(join(dataRoot, "operation-journal", name), "utf8")) as TaskOperationRecord;
  operations.push(entry);
}

const tasks: TaskReport[] = [];
const unreadable: Array<{ file: string; error: string }> = [];
for (const name of (await readdir(join(dataRoot, "tasks")).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort()) {
  const file = join(dataRoot, "tasks", name);
  try {
    const state = await readTaskState(file);
    tasks.push({
      id: state.id,
      file: name,
      status: state.status,
      phase: state.phase ?? null,
      taskType: state.taskType ?? null,
      contractVersion: state.contractVersion ?? 1,
      pauseReason: state.pauseReason ?? null,
      stopReason: state.stop?.reason ?? null,
      evidence: state.evidence.length,
      runs: state.runs?.length ?? 0,
      instances: state.cognition?.instances?.length ?? 0,
      violations: checkTaskInvariants(state, operations),
    });
  } catch (error) {
    unreadable.push({ file: name, error: error instanceof Error ? error.message : String(error) });
  }
}

const byCode: Record<string, number> = {};
for (const task of tasks) for (const violation of task.violations) byCode[violation.code] = (byCode[violation.code] ?? 0) + 1;
const report = {
  generatedAt: new Date().toISOString(),
  dataRoot,
  taskCount: tasks.length,
  tasksWithViolations: tasks.filter(task => task.violations.length > 0).length,
  violationCount: tasks.reduce((total, task) => total + task.violations.length, 0),
  byCode,
  uncheckable: UNCHECKABLE_INVARIANTS,
  unreadable,
  tasks,
};

console.log(`任务账本 ${tasks.length} 个（${dataRoot}）；无法解析 ${unreadable.length} 个`);
console.log(`违反不变量的任务 ${report.tasksWithViolations} 个，共 ${report.violationCount} 条`);
for (const [code, count] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)}  ${code}`);
for (const task of tasks) {
  const state = `${task.status}/${task.phase ?? "-"} · ${task.taskType ?? "-"} · 契约 v${task.contractVersion} · 证据 ${task.evidence} · 运行 ${task.runs} · 实例 ${task.instances}${task.pauseReason ? ` · 暂停原因 ${task.pauseReason}` : ""}${task.stopReason ? ` · 停止原因 ${task.stopReason}` : ""}`;
  console.log(`\n${task.id}  ${state}`);
  for (const violation of task.violations) console.log(`  [${violation.code}] ${violation.message}`);
  if (!task.violations.length) console.log("  无违反");
}
for (const entry of unreadable) console.log(`\n无法解析 ${entry.file}: ${entry.error}`);

if (outFile !== "-") {
  await mkdir(resolve(outFile, ".."), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n报告已写入 ${outFile}`);
}
