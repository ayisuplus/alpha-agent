import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore } from "../src/runtime/automations";
import { appendGlobalEvent, foldAutomations, foldQueue, globalLogDir, planGlobalEvent, readGlobalEvents } from "../src/runtime/global-events";
import { EventConflictError } from "../src/runtime/task-events";
import { TaskQueueStore } from "../src/runtime/task-queue";

const scratch = (label: string) => mkdtemp(join(tmpdir(), `alpha-${label}-`));

test("queue lifecycle events land in order and the fold reproduces the projection byte for byte", async () => {
  const root = await scratch("queue-events");
  try {
    const store = new TaskQueueStore(root);
    const item = await store.enqueue("task-1", "Review the queue");
    await store.start(item.id, "run-1");
    await store.finish(item.id, "task complete", true);
    const cancelled = await store.enqueue("task-1", "Second job");
    await store.cancel(cancelled.id);
    const at = new Date(Date.now() + 60_000);
    const schedule = await store.schedule("task-1", "Nightly", at.toISOString(), 60);
    const fired = await store.advanceDue(new Date(at.getTime() + 1000));
    await store.disable(schedule.id);

    const events = await readGlobalEvents(globalLogDir(root, "task-queue"));
    expect(events.map(event => [event.seq, event.type])).toEqual([
      [1, "queue/imported"],
      [2, "queue-item/enqueued"], [3, "queue-item/started"], [4, "queue-item/finished"],
      [5, "queue-item/enqueued"], [6, "queue-item/cancelled"],
      [7, "schedule/created"], [8, "queue-item/enqueued"], [9, "schedule/due-advanced"], [10, "schedule/disabled"],
    ]);
    // The envelope is the task log's: sequence-stamped, runtime-actor, ISO-dated, not scoped to a run.
    expect(events.every(event => event.actor === "runtime" && event.runId === undefined)).toBe(true);
    expect(events.map(event => new Date(event.at).toISOString())).toEqual(events.map(event => event.at));
    expect(events[3].payload).toMatchObject({ id: item.id, status: "complete", result: "task complete" });
    expect(events[5].payload).toMatchObject({ id: cancelled.id, result: "cancelled before start" });
    expect(fired[0]).toMatchObject({ scheduledFor: at.toISOString(), missedCount: 0, status: "pending" });
    expect(events[8].payload).toEqual({ id: schedule.id, nextRunAt: new Date(at.getTime() + 3_600_000).toISOString() });
    expect(events[9].payload).toEqual({ id: schedule.id });

    const folded = foldQueue(events);
    expect(folded.items.map(entry => entry.status)).toEqual(["complete", "failed", "pending"]);
    expect(folded.schedules[0]).toMatchObject({ id: schedule.id, active: false });
    expect(JSON.stringify(folded, null, 2)).toBe(await readFile(join(root, "task-queue.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("two writers on one log: the compare-and-swap loser re-plans after the winner lands", async () => {
  const root = await scratch("global-cas");
  try {
    const dir = globalLogDir(root, "task-queue");
    await appendGlobalEvent(dir, {
      at: new Date().toISOString(), actor: "runtime", type: "queue/imported",
      payload: { state: { items: [], schedules: [] }, source: "legacy-json" },
    }, 0);

    const planned: number[] = [];   // log length each writer's plan observed before writing
    const reFolded: string[] = [];  // writers that found the log moved on and re-planned
    const first = planGlobalEvent(dir, 1, async () => {
      planned.push((await readGlobalEvents(dir)).length);
      return {
        at: new Date().toISOString(), actor: "runtime", type: "queue-item/enqueued",
        payload: { item: { id: "item-first", taskId: "task-1", instruction: "first", status: "pending", createdAt: new Date().toISOString() } },
      };
    }, async () => { reFolded.push("first"); return (await readGlobalEvents(dir)).at(-1)!.seq; });
    const second = planGlobalEvent(dir, 1, async () => {
      planned.push((await readGlobalEvents(dir)).length);
      return {
        at: new Date().toISOString(), actor: "runtime", type: "queue-item/enqueued",
        payload: { item: { id: "item-second", taskId: "task-1", instruction: "second", status: "pending", createdAt: new Date().toISOString() } },
      };
    }, async () => { reFolded.push("second"); return (await readGlobalEvents(dir)).at(-1)!.seq; });
    await Promise.all([first, second]);

    expect(reFolded).toHaveLength(1);             // exactly one writer lost the compare-and-swap...
    expect([...planned].sort()).toEqual([1, 2]);   // ...and made its plan only after re-folding the winner's event
    const events = await readGlobalEvents(dir);
    expect(events.map(event => event.seq)).toEqual([1, 2, 3]);
    expect(foldQueue(events).items.map(entry => entry.id).sort()).toEqual(["item-first", "item-second"]);

    // A writer that does not re-plan is rejected outright instead of silently merged.
    const stale = appendGlobalEvent(dir, {
      at: new Date().toISOString(), actor: "runtime", type: "queue-item/enqueued",
      payload: { item: { id: "item-stale", taskId: "task-1", instruction: "stale", status: "pending", createdAt: new Date().toISOString() } },
    }, 1);
    await expect(stale).rejects.toBeInstanceOf(EventConflictError);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("automation lifecycle events land in order and the fold reproduces the projection byte for byte", async () => {
  const root = await scratch("automation-events");
  try {
    const store = new AutomationStore(root);
    const automation = await store.create({
      name: "Daily check", prompt: "Inspect the project", kind: "cron",
      schedule: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
      modelSelector: null, notificationPolicy: "failures",
    }, "PAUSED");
    await store.update(automation.id, { name: "Renamed check" });
    await store.update(automation.id, { status: "ACTIVE" });
    const run = await store.runNow(automation.id);
    await store.start(run.id, "task-1", "operation-1");
    await store.finish(run.id, "complete", "task complete");
    await store.markRead(run.id);
    await store.delete(automation.id);

    const events = await readGlobalEvents(globalLogDir(root, "automations"));
    expect(events.map(event => [event.seq, event.type])).toEqual([
      [1, "automation/imported"],
      [2, "automation/created"],
      [3, "automation/updated"],
      [4, "automation/status-changed"],
      [5, "automation-run/queued"],
      [6, "automation-run/started"],
      [7, "automation-run/finished"],
      [8, "automation-run/read"],
      [9, "automation/deleted"],
    ]);
    const folded = foldAutomations(events);
    // The byte comparison runs before the matcher assertions: bun's `expect.any` replaces the matched leaf in the
    // received object, which would corrupt the shared payload records the fold rebuilds the state from.
    expect(JSON.stringify(folded, null, 2)).toBe(await readFile(join(root, "automations.json"), "utf8"));
    expect(events[3].payload).toMatchObject({ id: automation.id, status: "ACTIVE" });
    expect(events[8].payload).toEqual({ id: automation.id, deletedAt: expect.any(String) });
    expect(folded.automations[0]).toMatchObject({ name: "Renamed check", status: "PAUSED", deletedAt: expect.any(String) });
    expect(folded.runs[0]).toMatchObject({ status: "complete", taskId: "task-1", operationId: "operation-1", readAt: expect.any(String) });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a due automation advances its record and queues one run, both folded", async () => {
  const root = await scratch("automation-due");
  try {
    const store = new AutomationStore(root);
    const startAt = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000);
    const automation = await store.create({
      name: "Hourly check", prompt: "Inspect the project", kind: "cron",
      schedule: { kind: "rrule", rule: "FREQ=HOURLY;INTERVAL=1", timeZone: "UTC", startAt: startAt.toISOString() },
      modelSelector: null, notificationPolicy: "failures",
    });
    const [run] = await store.advanceDue(new Date(startAt.getTime() + 3 * 3_600_000 + 1000));
    expect(run).toMatchObject({ automationId: automation.id, missedCount: 3, status: "pending" });

    const events = await readGlobalEvents(globalLogDir(root, "automations"));
    expect(events.map(event => event.type)).toEqual(["automation/imported", "automation/created", "automation/updated", "automation-run/queued"]);
    expect(events[2].payload).toEqual({ automation: { ...automation, nextRunAt: new Date(startAt.getTime() + 4 * 3_600_000).toISOString() } });
    expect(JSON.stringify(foldAutomations(events), null, 2)).toBe(await readFile(join(root, "automations.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a pre-event projection is imported once as the origin, leaving the file untouched", async () => {
  const root = await scratch("global-import");
  try {
    const file = join(root, "task-queue.json");
    // An older build's projection: it predates the `schedules` field, so the import must tolerate its absence.
    const legacy = JSON.stringify({
      items: [{ id: "item-1", taskId: "task-1", instruction: "Legacy job", status: "pending", createdAt: "2026-09-20T08:00:00.000Z" }],
    }, null, 2);
    await writeFile(file, legacy);
    const store = new TaskQueueStore(root);
    await store.reconcile();  // first touch imports and changes nothing
    expect(await readFile(file, "utf8")).toBe(legacy);

    const events = await readGlobalEvents(globalLogDir(root, "task-queue"));
    expect(events.map(event => [event.seq, event.type])).toEqual([[1, "queue/imported"]]);
    expect(events[0].payload).toMatchObject({
      source: "legacy-json",
      state: { items: [expect.objectContaining({ id: "item-1" })], schedules: [] },
    });

    await store.start("item-1", "run-1");  // later touches append events and never import again
    const after = await readGlobalEvents(globalLogDir(root, "task-queue"));
    expect(after.map(event => event.type)).toEqual(["queue/imported", "queue-item/started"]);
    expect(JSON.stringify(foldQueue(after), null, 2)).toBe(await readFile(file, "utf8"));

    const automationFile = join(root, "automations.json");
    const automationLegacy = JSON.stringify({ automations: [], runs: [] }, null, 2);
    await writeFile(automationFile, automationLegacy);
    await new AutomationStore(root).reconcile();
    expect(await readFile(automationFile, "utf8")).toBe(automationLegacy);
    const automationEvents = await readGlobalEvents(globalLogDir(root, "automations"));
    expect(automationEvents.map(event => [event.seq, event.type])).toEqual([[1, "automation/imported"]]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
