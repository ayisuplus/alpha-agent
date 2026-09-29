import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { OperationJournal } from "../src/runtime/operation-journal";
import { TaskLedger, fingerprintSource } from "../src/runtime/task-ledger";
import { foldTask, readEvents, taskLogDir } from "../src/runtime/task-events";
import { checkTaskInvariants } from "../src/runtime/task-invariants";

test("task session journal is reopened from its task-specific file", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-session-persist-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const file = join(sessionDir, "task.jsonl");
  const first = await SessionManager.open(file, sessionDir, undefined, { initialCwd: root });
  first.appendMessage({ role: "user", content: "Persist this turn", timestamp: Date.now() });
  await first.close();
  const second = await SessionManager.open(file, sessionDir, undefined, { initialCwd: root, throwIfMissing: true });
  expect(second.getBranch().some(item => item.type === "message" && item.message.role === "user")).toBe(true);
  await second.close();
});

test("an interrupted run reconciles source and stops before another model run", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-operation-reconcile-"));
  const project = join(root, "products", "work");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "note.txt"), "before");
  const ledger = await TaskLedger.create(join(root, "data"), { objective: "Change note", projectRoot: project, criteria: [{ id: "artifact", description: "Result", kind: "artifact" }] });
  await ledger.recordDispatch({ id: "interrupted-worker", orderId: "change", kind: "execute", skills: [] });
  const journal = new OperationJournal(join(root, "data"));
  await journal.start(ledger.state.id, "run-1");
  await writeFile(join(project, "note.txt"), "after");
  const result = await journal.reconcile();
  expect(result).toEqual([{ taskId: ledger.state.id, result: "stopped-after-reconcile" }]);
  const loaded = await TaskLedger.load(ledger.file);
  expect(loaded.state.status).toBe("stopped");
  expect(loaded.state.revision).toBe(await fingerprintSource(project));
  expect(loaded.state.cognition?.instances?.[0].status).toBe("failed");
  expect(await journal.reconcile()).toEqual([]);
});

test("a ledger that predates the event log is backed up and imported unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-legacy-ledger-"));
  const project = join(root, "products", "work");
  await mkdir(project, { recursive: true });
  const created = await TaskLedger.create(join(root, "data"), { objective: "Legacy", projectRoot: project, criteria: [{ id: "build", description: "Build", kind: "build" }] });
  const legacy = { ...created.state } as Record<string, unknown>;
  delete legacy.taskType;
  delete legacy.contractVersion;
  const original = JSON.stringify(legacy);
  // Without a log directory the file reads as one written before events existed.
  await rm(taskLogDir(created.file), { recursive: true, force: true });
  await writeFile(created.file, original);

  const loaded = await TaskLedger.load(created.file);
  expect(loaded.state.taskType).toBeUndefined();
  expect(loaded.state.contractVersion).toBeUndefined();
  expect(await readFile(created.file, "utf8")).toBe(original);
  expect(await readFile(`${created.file}.pre-events.bak`, "utf8")).toBe(original);

  await loaded.recordGuidance("Keep prior task data");
  const reloaded = await TaskLedger.load(created.file);
  expect(reloaded.state.guidanceHistory?.at(-1)?.instruction).toBe("Keep prior task data");
  expect(reloaded.state.contractVersion).toBeUndefined();
  expect(await readFile(`${created.file}.pre-events.bak`, "utf8")).toBe(original);
});

test("the operation latch is an event and the projection file keeps its shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-operation-latch-"));
  try {
    const projectRoot = join(root, "project");
    await mkdir(projectRoot, { recursive: true });
    const dataRoot = join(root, "data");
    const ledger = await TaskLedger.create(dataRoot, { objective: "Latch one run", projectRoot, taskType: "general", criteria: [] });
    const journal = new OperationJournal(dataRoot);

    await journal.start(ledger.state.id, "run-1", ledger);
    expect(ledger.state.operation).toMatchObject({ runId: "run-1", status: "running" });
    await expect(journal.start(ledger.state.id, "run-2", ledger)).rejects.toThrow("Task has an unreconciled operation");
    await journal.finish(ledger.state.id, "run-1", ledger);
    expect(ledger.state.operation).toMatchObject({ runId: "run-1", status: "finished" });
    expect(checkTaskInvariants(ledger.state)).toEqual([]);

    const events = await readEvents(taskLogDir(ledger.file));
    expect(events.filter(event => event.type.startsWith("operation/")).map(event => event.type)).toEqual(["operation/started", "operation/finished"]);
    expect(foldTask(events)).toEqual(ledger.state);

    // The projection is what reconcile() and the scan read: same shape, now with a format tag.
    const projection = JSON.parse(await readFile(join(dataRoot, "operation-journal", `${ledger.state.id}.json`), "utf8")) as { runId: string; status: string; format?: string; version?: number };
    expect(projection).toMatchObject({ runId: "run-1", status: "finished", format: "operation-journal", version: 1 });

    // A latch left running by a dead process is a violation of the one-run invariant.
    await journal.start(ledger.state.id, "run-2", ledger);
    await ledger.stop("user", "Cancelled");
    expect(checkTaskInvariants(ledger.state).map(item => item.code)).toEqual(["I2/stale-operation-latch"]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
