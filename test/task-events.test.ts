import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger, type TaskState } from "../src/runtime/task-ledger";
import {
  EventConflictError, InvariantError, SNAPSHOT_INTERVAL, appendEvent, applyEvent, eventLogPath, foldTask,
  inspectLogTail, latestSnapshot, readEvents, taskLogDir, writeSnapshot,
} from "../src/runtime/task-events";

const revision = "a".repeat(64);

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "alpha-task-events-"));
}

async function newTask(root: string, name = "project"): Promise<TaskLedger> {
  const projectRoot = join(root, name);
  await Bun.write(join(projectRoot, "app.txt"), "v1");
  return TaskLedger.create(join(root, "data"), {
    objective: "Fix the cart total", projectRoot, taskType: "code-change",
    criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }],
  });
}

function legacyState(id: string, projectRoot: string): TaskState {
  return {
    id, taskType: "code-change", objective: "Legacy task", contractVersion: 1, contractHistory: [], guidanceHistory: [],
    cognition: { revision: 1, recipeVersion: 1, summary: "Legacy task", candidates: [], steps: [], gaps: [], amendments: [] },
    projectRoot, criteria: [{ id: "check", description: "Configured checks pass", kind: "test" }], status: "stopped",
    phase: "execute", revision, evidence: [], runs: [], preview: null, lastFailure: "User cancelled",
    createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T09:00:00.000Z",
  };
}

test("every mutation appends an event and the fold reproduces the projection byte for byte", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    await ledger.recordGuidance("Keep the public API unchanged");
    await ledger.recordFailure("Browser verification stopped at step 3");
    await ledger.recordRun({ model: "test/model", toolCalls: 3, maxToolCalls: 40, wallTimeMs: 1000, elapsedMs: 500, outcome: "returned" });
    await ledger.needInput("Approve `bun test`?", "approval");
    await ledger.resume("Approved");

    const events = await readEvents(taskLogDir(ledger.file));
    expect(events.map(event => event.type)).toEqual([
      "task/created", "guidance/recorded", "failure/recorded", "run/ended", "status/changed", "status/changed",
    ]);
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.every(event => event.actor === "runtime")).toBe(true);
    expect(events[4].payload).toMatchObject({ status: "needs-input", question: "Approve `bun test`?", service: "approval" });

    const folded = JSON.stringify(foldTask(events), null, 2);
    expect(folded).toBe(await readFile(ledger.file, "utf8"));
    expect(JSON.parse(folded) as TaskState).toEqual(ledger.state);
    expect((await TaskLedger.load(ledger.file)).state).toEqual(ledger.state);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("appends are sequence compare-and-swap: a stale writer is rejected, not silently merged", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    const dir = taskLogDir(ledger.file);
    const draft = { at: "2026-09-28T10:00:00.000Z", actor: "runtime" as const, type: "failure/recorded" as const, payload: { reason: "Stale writer" } };
    await appendEvent(dir, draft, 1);
    const conflict = appendEvent(dir, draft, 1);
    await expect(conflict).rejects.toBeInstanceOf(EventConflictError);
    expect((await readEvents(dir)).map(event => event.seq)).toEqual([1, 2]);
    await expect(appendEvent(dir, draft, 5)).rejects.toThrow(/expected seq 5, found 2/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a retry after a conflict re-folds the winner's events instead of overwriting them", async () => {
  const root = await scratch();
  try {
    const first = await newTask(root);
    const second = await TaskLedger.load(first.file);
    await first.recordGuidance("Written while the second handle was stale");
    await second.recordGuidance("Written after re-folding");
    const events = await readEvents(taskLogDir(first.file));
    expect(events.map(event => event.seq)).toEqual([1, 2, 3]);
    const reloaded = await TaskLedger.load(first.file);
    expect(reloaded.state.guidanceHistory?.map(item => item.instruction)).toEqual([
      "Written while the second handle was stale", "Written after re-folding",
    ]);
    expect(reloaded.eventSeq).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a torn trailing line is truncated on the next append and never folded", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    const dir = taskLogDir(ledger.file);
    await appendFile(eventLogPath(dir), '{"seq":2,"at":"2026-09-28T10:00:00.000Z","actor":"runtime","type":"fail');
    const tail = await inspectLogTail(dir);
    expect(tail.torn).toBe(true);
    expect(tail.seq).toBe(1);
    expect((await readEvents(dir)).map(event => event.seq)).toEqual([1]);
    await ledger.recordFailure("Appended after the torn line was dropped");
    const events = await readEvents(dir);
    expect(events.map(event => event.seq)).toEqual([1, 2]);
    expect(foldTask(events).lastFailure).toBe("Appended after the torn line was dropped");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a snapshot shortens the fold and older snapshots are pruned", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    for (let index = 0; index < 5; index++) await ledger.recordFailure(`failure ${index}`);
    const dir = taskLogDir(ledger.file);
    const events = await readEvents(dir);
    await writeSnapshot(dir, 3, foldTask(events.slice(0, 3)));
    await writeSnapshot(dir, 5, foldTask(events.slice(0, 5)));
    expect((await readdir(dir)).filter(name => name.startsWith("snapshot."))).toEqual(["snapshot.5.json"]);

    const snapshot = await latestSnapshot(dir);
    expect(snapshot?.seq).toBe(5);
    const fromSnapshot = foldTask(await readEvents(dir, snapshot!.offset), { base: { seq: snapshot!.seq, state: snapshot!.state } });
    expect(fromSnapshot).toEqual(foldTask(events));
    expect(fromSnapshot.lastFailure).toBe("failure 4");

    await ledger.recordFailure("failure 5");
    const reloaded = await TaskLedger.load(ledger.file);
    expect(reloaded.state.lastFailure).toBe("failure 5");
    expect(reloaded.eventSeq).toBe(7);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a pre-event-log ledger is imported once, without rewriting the JSON file", async () => {
  const root = await scratch();
  try {
    const id = "0f0a6c3e-6a4e-4c3a-9b1e-2f5c9d0a1b2c";
    const file = join(root, "data", "tasks", `${id}.json`);
    await mkdir(join(root, "data", "tasks"), { recursive: true });
    const contents = JSON.stringify(legacyState(id, join(root, "project")), null, 2);
    await writeFile(file, contents);

    const ledger = await TaskLedger.load(file);
    expect(ledger.state.status).toBe("stopped");
    expect(await readFile(file, "utf8")).toBe(contents);
    expect(await readFile(`${file}.pre-events.bak`, "utf8")).toBe(contents);

    const events = await readEvents(taskLogDir(file));
    expect(events.map(event => [event.seq, event.type])).toEqual([[1, "task/imported"]]);
    expect(foldTask(events)).toEqual(legacyState(id, join(root, "project")));

    await ledger.resume("Continue after the import");
    expect(ledger.state.status).toBe("active");
    expect((await readEvents(taskLogDir(file))).length).toBe(2);
    const reloaded = await TaskLedger.load(file);
    expect(reloaded.state.status).toBe("active");
    expect(reloaded.state.guidanceHistory?.map(item => item.instruction)).toEqual(["Continue after the import"]);
    expect(await readFile(`${file}.pre-events.bak`, "utf8")).toBe(contents);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** The stable code of the error a fold throws, or null when it does not. */
function codeOf(run: () => unknown): string | null {
  try { run(); return null; } catch (error) { return (error as InvariantError).code; }
}

test("the fold rejects a broken log with a stable code", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    const events = await readEvents(taskLogDir(ledger.file));
    expect(codeOf(() => foldTask([]))).toBe("fold/empty-log");
    expect(codeOf(() => foldTask([{ ...events[0], type: "failure/recorded", payload: { reason: "no origin" } } as never]))).toBe("fold/missing-origin");
    expect(codeOf(() => foldTask([...events, { ...events[0], seq: events.length + 1 }]))).toBe("fold/duplicate-origin");
    expect(codeOf(() => foldTask([events[0], { ...events[1], seq: 3 }]))).toBe("fold/seq-gap");
    expect(codeOf(() => applyEvent({} as TaskState, { ...events[0], type: "task/renamed" } as never))).toBe("fold/unknown-event");
    expect(foldTask(events)).toEqual(ledger.state);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("the transition table rejects changes no event may cause", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    const events = await readEvents(taskLogDir(ledger.file));
    const at = "2026-09-28T10:00:00.000Z";
    const toPlan = { seq: 2, at, actor: "runtime" as const, type: "phase/changed" as const, payload: { phase: "plan" as const, clearPause: false } };
    expect(foldTask([...events, toPlan]).phase).toBe("plan");
    // Only an approved plan may start execution, so a hand-written phase event is refused by the table.
    expect(codeOf(() => foldTask([...events, toPlan, { ...toPlan, seq: 3, payload: { phase: "execute" as const, clearPause: false } }]))).toBe("transition/phase-not-allowed");

    const stopped = { seq: 2, at, actor: "runtime" as const, type: "status/changed" as const, payload: { status: "stopped" as const } };
    expect(foldTask([...events, stopped]).status).toBe("stopped");
    // A stopped task cannot pause: the reducer's own guard fires before the table is consulted.
    expect(codeOf(() => foldTask([...events, stopped, { ...stopped, seq: 3, payload: { status: "needs-input" as const, question: "Approve?", service: "approval" } }]))).toBe("apply/task-not-active");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("two processes appending to one task lose nothing", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    const worker = join(import.meta.dir, "support", "append-worker.ts");
    const runs = ["a", "b"].map(label => Bun.spawn([process.execPath, "run", worker, ledger.file, "100", label], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(runs.map(async process => ({ exitCode: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() })));
    for (const result of results) expect([result.exitCode, result.stderr]).toEqual([0, ""]);

    const events = await readEvents(taskLogDir(ledger.file));
    expect(events.length).toBe(201);
    expect(events.map(event => event.seq)).toEqual(events.map((_event, index) => index + 1));
    const reloaded = await TaskLedger.load(ledger.file);
    const reasons = (reloaded.state.runs ?? []).map(run => run.failureReason ?? "");
    expect(reasons.length).toBe(200);
    expect(new Set(reasons).size).toBe(200);
    expect(foldTask(events)).toEqual(reloaded.state);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

test("the log snapshots itself periodically and loads from the snapshot", async () => {
  const root = await scratch();
  try {
    const ledger = await newTask(root);
    for (let index = 0; index < SNAPSHOT_INTERVAL; index++) await ledger.recordFailure(`failure ${index}`);
    const dir = taskLogDir(ledger.file);
    expect(ledger.eventSeq).toBe(SNAPSHOT_INTERVAL + 1);
    expect((await readdir(dir)).filter(name => name.startsWith("snapshot."))).toEqual([`snapshot.${SNAPSHOT_INTERVAL}.json`]);
    expect((await latestSnapshot(dir))?.seq).toBe(SNAPSHOT_INTERVAL);

    const reloaded = await TaskLedger.load(ledger.file);
    expect(reloaded.state).toEqual(ledger.state);
    expect(reloaded.state.lastFailure).toBe(`failure ${SNAPSHOT_INTERVAL - 1}`);
    expect(reloaded.eventSeq).toBe(SNAPSHOT_INTERVAL + 1);

    // Snapshots are caches: without one the fold replays the whole log to the same state.
    await rm(join(dir, `snapshot.${SNAPSHOT_INTERVAL}.json`));
    expect((await TaskLedger.load(ledger.file)).state).toEqual(ledger.state);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
