import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { OperationJournal } from "../src/runtime/operation-journal";
import { TaskLedger, fingerprintSource } from "../src/runtime/task-ledger";

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
  await ledger.recordDispatch({ id: "interrupted-worker", orderId: "change", mode: "implement", skills: [] });
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

test("a legacy ledger is backed up before its first contract update", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-legacy-ledger-"));
  const project = join(root, "products", "work");
  await mkdir(project, { recursive: true });
  const created = await TaskLedger.create(join(root, "data"), { objective: "Legacy", projectRoot: project, criteria: [{ id: "build", description: "Build", kind: "build" }] });
  const legacy = { ...created.state } as Record<string, unknown>;
  delete legacy.taskType;
  delete legacy.contractVersion;
  const original = JSON.stringify(legacy);
  await writeFile(created.file, original);
  const loaded = await TaskLedger.load(created.file);
  await loaded.recordGuidance("Keep prior task data");
  expect(await readFile(`${created.file}.pre-contract-extension.bak`, "utf8")).toBe(original);
  expect((await TaskLedger.load(created.file)).state.guidanceHistory?.at(-1)?.instruction).toBe("Keep prior task data");
});
