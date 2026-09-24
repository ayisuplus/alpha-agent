import { dirname, resolve } from "node:path";
import { runTask } from "./runtime/omp-runner";
import { TaskLedger } from "./runtime/task-ledger";

function option(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const command = Bun.argv[2];
const dataRoot = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? process.cwd(), ".alpha");
if (command === "run") {
  const projectRoot = option("project");
  const objective = option("brief");
  if (!projectRoot || !objective) throw new Error("Usage: bun run alpha run --project <directory> --brief <goal> [--model provider/id]");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const ledger = await runTask({
    projectRoot,
    objective,
    modelSelector: option("model"),
    dataRoot,
    signal: controller.signal,
    onEvent(event) {
      if (event.type === "text") process.stdout.write(event.value);
      else process.stdout.write(`\n[${event.type}: ${event.value}${event.error ? " ERROR" : ""}]\n`);
    },
  });
  process.stdout.write(`\nTask ${ledger.state.id}: ${ledger.state.status}; pending ${ledger.completionGaps().join(", ")}\n`);
  process.stdout.write(`Ledger: ${ledger.file}\n`);
} else if (command === "status") {
  const file = option("ledger");
  if (!file) throw new Error("Usage: bun run alpha status --ledger <task-file>");
  const ledger = await TaskLedger.load(file);
  console.log(JSON.stringify({ id: ledger.state.id, status: ledger.state.status, revision: ledger.state.revision, pending: ledger.completionGaps(), preview: ledger.state.preview }, null, 2));
} else if (command === "resume") {
  const file = option("ledger");
  const correction = option("brief");
  if (!file || !correction) throw new Error("Usage: bun run alpha resume --ledger <task-file> --brief <correction>");
  const existingLedger = await TaskLedger.load(file);
  if (existingLedger.state.status === "stopped") await existingLedger.resume(correction);
  else await existingLedger.recordGuidance(correction);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const ledger = await runTask({
    projectRoot: existingLedger.state.projectRoot,
    objective: correction,
    existingLedger,
    dataRoot: dirname(dirname(existingLedger.file)),
    signal: controller.signal,
    onEvent(event) {
      if (event.type === "text") process.stdout.write(event.value);
      else process.stdout.write(`\n[${event.type}: ${event.value}${event.error ? " ERROR" : ""}]\n`);
    },
  });
  process.stdout.write(`\nTask ${ledger.state.id}: ${ledger.state.status}; pending ${ledger.completionGaps().join(", ")}\n`);
} else {
  console.log("Usage: bun run alpha <run|resume|status> ...");
}
