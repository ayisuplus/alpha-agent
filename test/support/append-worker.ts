// Appends run records to one task ledger from a separate process. The event log concurrency test starts two of these
// against the same task and expects every append to survive: sequence compare-and-swap plus re-fold, no lost writes.
import { TaskLedger } from "../../src/runtime/task-ledger";

const [file, count, label] = process.argv.slice(2);
const ledger = await TaskLedger.load(file);
for (let index = 0; index < Number(count); index++) {
  await ledger.recordRun({ model: "test/model", toolCalls: 1, maxToolCalls: 10, wallTimeMs: 100, elapsedMs: 10, outcome: "returned", failureReason: `${label}-${index}` });
}
process.stdout.write(`appended ${count} runs as ${label}\n`);
