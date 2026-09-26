import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { acceptCodeChange } from "./runtime/code-acceptance";
import { AgentPresetStore } from "./runtime/agent-presets";
import { runDevelopmentWorkflow } from "./runtime/development-workflow";
import { TaskLedger } from "./runtime/task-ledger";
import { importCodeWorkspace } from "./runtime/workspace-import";
import { bindProjectTurn, finalizeProjectTurn, mayWriteProject, prepareProjectTurn } from "./runtime/project-state";
import { ProjectStore } from "./runtime/projects";
import { verifySandbox } from "./runtime/sandbox-exec";
import type { RunEvent } from "./runtime/omp-runner";

function option(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const command = Bun.argv[2];
const dataRoot = resolve(process.env.ALPHA_WORKSPACE_ROOT ?? process.cwd(), ".alpha");
async function cliTurn(projectRoot: string, existing: TaskLedger | undefined, run: (onLedger: (ledger: TaskLedger) => Promise<void>, onEvent: (event: RunEvent) => void) => Promise<TaskLedger>): Promise<TaskLedger> {
  const turnDataRoot = existing ? dirname(dirname(existing.file)) : dataRoot;
  if (existing?.state.workspaceOrigin?.kind === "direct" && existing.state.projectId) {
    const roots = await new ProjectStore(turnDataRoot).roots(existing.state.projectId, existing.state.projectVersion ?? 0);
    await verifySandbox({ cwd: projectRoot, roots, dataRoot: turnDataRoot });
  }
  const turn = await prepareProjectTurn({ dataRoot: turnDataRoot, projectRoot, runId: randomUUID(), ledger: existing });
  let ledger = existing;
  let failed = false;
  let writingToolObserved = false;
  try {
    ledger = await run(created => bindProjectTurn(turn, created), event => { if (event.type === "tool-start" && mayWriteProject(event.value)) writingToolObserved = true; });
    return ledger;
  } catch (error) { failed = true; throw error; }
  finally {
    const current = ledger ?? (turn.taskId ? await TaskLedger.load(join(turnDataRoot, "tasks", `${turn.taskId}.json`)).catch(() => null) : null);
    if (current) {
      try {
        await finalizeProjectTurn(turn, current, writingToolObserved);
        if (!failed && current.state.status === "active" && current.state.phase === "execute" && !current.completionGaps().length) await current.complete();
      } catch (error) {
        if (current.state.status === "active") await current.needInput(`项目状态收尾失败：${error instanceof Error ? error.message : String(error)}`, "project-state");
        throw error;
      }
    }
  }
}
if (command === "run") {
  const projectRoot = option("project");
  const objective = option("brief");
  if (!projectRoot || !objective) throw new Error("Usage: bun run alpha run --project <directory> --brief <goal> [--model provider/id]");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const ledger = await cliTurn(projectRoot, undefined, (onLedger, observeEvent) => runDevelopmentWorkflow({
    projectRoot,
    objective,
    modelSelector: option("model"),
    dataRoot,
    signal: controller.signal,
    onLedger,
    onEvent(event) {
      observeEvent(event);
      if (event.type === "text") process.stdout.write(event.value);
      else process.stdout.write(`\n[${event.type}: ${event.value}${event.error ? " ERROR" : ""}]\n`);
    },
  }));
  process.stdout.write(`\nTask ${ledger.state.id}: ${ledger.state.status}; pending ${ledger.completionGaps().join(", ")}\n`);
  process.stdout.write(`Ledger: ${ledger.file}\n`);
} else if (command === "run-code") {
  const sourcePath = option("source");
  const objective = option("brief");
  if (!sourcePath || !objective) throw new Error("Usage: bun run alpha run-code --source <directory> --brief <goal> [--model provider/id] [--expert expert-id]");
  const designatedExpertId = option("expert");
  if (designatedExpertId && !(await new AgentPresetStore(dataRoot).enabled()).some(item => item.id === designatedExpertId)) throw new Error(`Expert does not exist or is disabled: ${designatedExpertId}`);
  const ledger = await importCodeWorkspace({ sourcePath, productsRoot: join(dirname(dataRoot), "products"), dataRoot, objective, modelSelector: option("model"), designatedExpertId });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const result = await cliTurn(ledger.state.projectRoot, ledger, async (onLedger, observeEvent) => {
    const current = await runDevelopmentWorkflow({ projectRoot: ledger.state.projectRoot, objective, modelSelector: option("model"), existingLedger: ledger, dataRoot, signal: controller.signal, onLedger,
    onEvent(event) {
      observeEvent(event);
      if (event.type === "text") process.stdout.write(event.value);
      else process.stdout.write(`\n[${event.type}: ${event.value}${event.error ? " ERROR" : ""}]\n`);
    },
    });
    if (current.state.status === "active" && !controller.signal.aborted) await acceptCodeChange({ ledger: current, dataRoot, runId: randomUUID(), signal: controller.signal, complete: false, onCheck: name => process.stdout.write(`\n[check: ${name}]\n`) });
    return current;
  });
  process.stdout.write(`\nTask ${result.state.id}: ${result.state.status}; pending ${result.completionGaps().join(", ")}\n`);
  process.stdout.write(`Ledger: ${result.file}\n`);
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
  const ledger = await cliTurn(existingLedger.state.projectRoot, existingLedger, async (onLedger, observeEvent) => {
    const current = await runDevelopmentWorkflow({
    projectRoot: existingLedger.state.projectRoot,
    objective: correction,
    existingLedger,
    dataRoot: dirname(dirname(existingLedger.file)),
    signal: controller.signal,
    onLedger,
    onEvent(event) {
      observeEvent(event);
      if (event.type === "text") process.stdout.write(event.value);
      else process.stdout.write(`\n[${event.type}: ${event.value}${event.error ? " ERROR" : ""}]\n`);
    },
    });
    if (current.state.taskType === "code-change" && current.state.status === "active" && !controller.signal.aborted) await acceptCodeChange({ ledger: current, dataRoot: dirname(dirname(current.file)), runId: randomUUID(), signal: controller.signal, complete: false, onCheck: name => process.stdout.write(`\n[check: ${name}]\n`) });
    return current;
  });
  process.stdout.write(`\nTask ${ledger.state.id}: ${ledger.state.status}; pending ${ledger.completionGaps().join(", ")}\n`);
} else {
  console.log("Usage: bun run alpha <run|run-code|resume|status> ...");
}
