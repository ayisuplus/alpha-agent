import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runDevelopmentWorkflow } from "../src/runtime/development-workflow";
import { ProjectStore } from "../src/runtime/projects";
import { TaskLedger } from "../src/runtime/task-ledger";

const model = "xiaomi-token-plan-cn/mimo-v2.6-flash";
const root = resolve(import.meta.dir, "..", "artifacts", "mimo-long-20260926");
const runId = randomUUID();
const runRoot = join(root, "runs", runId);
const projectRoot = join(resolve(import.meta.dir, "..", ".."), "alpha-mimo-long-20260926", runId);
const dataRoot = join(runRoot, "state");
const reportPath = join(runRoot, "report.json");
const eventsPath = join(runRoot, "events.jsonl");
const testPaths = ["test/parse.test.ts", "test/reconcile.test.ts", "test/cli.test.ts", "test/fixtures/events.csv"];
const objective = [
  "Build the real event-ledger CLI in this isolated project. The checked-in tests are the acceptance contract: implement robust CSV event parsing, idempotent per-account reconciliation, and a CLI that reads a CSV file path and prints JSON. Preserve src/contracts.ts and all test files.",
  "Use alpha_spawn to delegate two independent implementation orders concurrently: one owns src/parse.ts and one owns src/reconcile.ts. Give both full worktree access; the parent should inspect each returned diff, integrate accepted changes, and implement src/cli.ts. Each worker must run only the configured alpha_check script named test; failures in unrelated, still-unimplemented modules are expected in each isolated worktree. Inspect the relevant suite lines in that full-test output and return the implementation for parent review. Do not ask to run a single-file test through alpha_command, because it is not a configured check. After integration, the parent runs alpha_check test for the full suite.",
  "Do the work now without asking for plan approval. A final independent worktree review should check the source against the tests and report actual evidence. Do not claim success from an unrun test."
].join(" ");

await mkdir(runRoot, { recursive: true });
await mkdir(dataRoot, { recursive: true });
await cp(join(root, "template"), projectRoot, { recursive: true });
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const initialTests = Object.fromEntries(await Promise.all(testPaths.map(async path => [path, hash(await readFile(join(projectRoot, path)))])));
const events = createWriteStream(eventsPath, { flags: "wx" });
const report: Record<string, unknown> = {
  model, objective, runRoot, projectRoot, dataRoot, eventsPath,
  startedAt: new Date().toISOString(), initialTestHashes: initialTests,
};
async function save() {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, output: (stdout + "\n" + stderr).slice(-8000) };
}
async function sourceFiles() {
  return (await readdir(join(projectRoot, "src"))).sort();
}

report.baseline = await command([process.execPath, "test", "./test"], projectRoot);
for (const args of [
  ["git", "init"],
  ["git", "add", "."],
  ["git", "-c", "user.name=Alpha", "-c", "user.email=alpha@local", "commit", "-m", "Initial event-ledger fixture"],
]) {
  const result = await command(args, projectRoot);
  if (result.exitCode !== 0) throw new Error("Cannot prepare isolated Git project: " + result.output);
}
const projects = new ProjectStore(dataRoot);
const createdProject = await projects.create("Mimo long-run event ledger");
const mountedProject = await projects.mount(createdProject.id, projectRoot);
await projects.setPermission(createdProject.id, "full");
await save();
console.log(JSON.stringify({ phase: "baseline", exitCode: (report.baseline as { exitCode: number }).exitCode, reportPath }));

const ledger = await TaskLedger.create(dataRoot, {
  objective, projectRoot, taskType: "code-change", startMode: "execute",
  projectId: createdProject.id, projectVersion: mountedProject.version, permissionMode: "full",
  workspaceOrigin: { kind: "direct", checks: [{ name: "test", command: "bun test ./test" }] },
  criteria: [
    { id: "parser", description: "CSV parser handles quotes, line endings, required cells and integer cents", kind: "asset" },
    { id: "reconcile", description: "Reconciliation is deterministic and idempotent, and rejects conflicting duplicates", kind: "asset" },
    { id: "cli", description: "CLI accepts a CSV file path and prints a JSON summary", kind: "asset" },
    { id: "tests", description: "All existing Bun tests pass unchanged", kind: "test" },
  ],
  modelSelector: model,
});
report.taskId = ledger.state.id;
report.ledgerPath = ledger.file;
await save();

let runnerError: string | null = null;
const start = performance.now();
try {
  await runDevelopmentWorkflow({
    projectRoot, dataRoot, objective, modelSelector: model, existingLedger: ledger,
    maxToolCalls: 110, maxTotalToolCalls: 360,
    wallTimeMs: 900_000, totalWallTimeMs: 1_200_000,
    signal: AbortSignal.timeout(1_200_000),
    onEvent: event => {
      if (event.type === "text") return;
      const item = {
        at: new Date().toISOString(), type: event.type, value: event.value.slice(0, 500),
        target: event.target, error: event.error,
      };
      events.write(JSON.stringify(item) + "\n");
      if (event.type === "status" || event.type === "tool-start") console.log(JSON.stringify(item));
    },
  });
} catch (error) {
  runnerError = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  events.end();
}

const current = await TaskLedger.load(ledger.file);
const finalTest = await command([process.execPath, "test", "./test"], projectRoot);
const finalHashes = Object.fromEntries(await Promise.all(testPaths.map(async path => [path, hash(await readFile(join(projectRoot, path)))])));
const instances = (current.state.cognition?.instances ?? []).map(item => ({
  id: item.id, orderId: item.orderId, status: item.status, parentId: item.parentId,
  kind: item.kind,
}));
report.finishedAt = new Date().toISOString();
report.elapsedMs = Math.round(performance.now() - start);
report.runnerError = runnerError;
report.status = current.state.status;
report.phase = current.state.phase;
report.gaps = current.completionGaps();
report.review = current.state.development?.review ?? null;
report.instances = instances;
report.runs = (current.state.runs ?? []).map(item => ({
  toolCalls: item.toolCalls, elapsedMs: item.elapsedMs, usage: item.usage,
}));
report.finalTest = finalTest;
report.testsUnchanged = testPaths.every(path => initialTests[path] === finalHashes[path]);
report.finalTestHashes = finalHashes;
report.sourceFiles = await sourceFiles();
report.sourceHashes = Object.fromEntries(await Promise.all((report.sourceFiles as string[]).map(async path => [
  path, hash(await readFile(join(projectRoot, "src", path))),
])));
report.gitHead = await command(["git", "rev-parse", "--short", "HEAD"], projectRoot);
report.worktrees = await command(["git", "worktree", "list", "--porcelain"], projectRoot);
report.success = !runnerError && finalTest.exitCode === 0 && report.testsUnchanged
  && instances.some(item => item.orderId === "parse" || item.orderId === "reconcile")
  && current.state.development?.review?.verdict === "pass";
await save();
console.log(JSON.stringify({
  phase: "done", success: report.success, status: report.status, review: current.state.development?.review?.verdict,
  finalTestExitCode: finalTest.exitCode, testsUnchanged: report.testsUnchanged,
  instanceCount: instances.length, elapsedMs: report.elapsedMs, reportPath,
}));
if (!report.success) process.exitCode = 1;
