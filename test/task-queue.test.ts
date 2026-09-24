import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskQueueStore } from "../src/runtime/task-queue";

test("a missed recurring schedule queues one catch-up run and records skipped times", async () => {
  const root = await mkdtemp(join(tmpdir(), "alpha-queue-"));
  const store = new TaskQueueStore(root);
  const start = new Date(Date.now() + 60_000);
  const schedule = await store.schedule("task", "review", start.toISOString(), 10);
  const now = new Date(start.getTime() + 35 * 60_000);
  const due = await store.advanceDue(now);
  expect(due).toHaveLength(1);
  expect(due[0]).toMatchObject({ scheduledFor: start.toISOString(), missedCount: 3, status: "pending" });
  expect(await store.advanceDue(now)).toEqual([]);
  expect(new Date((await store.all()).schedules.find(item => item.id === schedule.id)!.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
  await store.start(due[0].id, "run");
  await store.reconcile();
  expect((await store.all()).items[0]).toMatchObject({ status: "failed", result: expect.stringContaining("interrupted") });
});
