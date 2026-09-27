import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore, nextAutomationTime, type AutomationInput } from "../src/runtime/automations";

const root = () => mkdtemp(join(tmpdir(), "alpha-automations-"));
const input = (schedule: AutomationInput["schedule"]): AutomationInput => ({ name: "Daily check", prompt: "Inspect the project", kind: "cron", schedule, modelSelector: null, notificationPolicy: "failures" });

test("RRULE keeps local wall time and weekday across daylight saving", () => {
  const daily = { kind: "rrule" as const, rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", timeZone: "America/New_York", startAt: "2026-03-07T14:00:00.000Z" };
  expect(nextAutomationTime(daily, new Date("2026-03-07T14:00:00.000Z"))).toBe("2026-03-08T13:00:00.000Z");
  const weekly = { ...daily, rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0" };
  expect(nextAutomationTime(weekly, new Date("2026-03-09T13:00:00.000Z"))).toBe("2026-03-16T13:00:00.000Z");
  const repeated = { ...daily, rule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30", startAt: "2026-10-31T05:30:00.000Z" };
  expect(nextAutomationTime(repeated, new Date("2026-11-01T05:30:00.000Z"))).toBe("2026-11-02T06:30:00.000Z");
});

test("one-time automation produces one independent run and retains its history", async () => {
  const store = new AutomationStore(await root());
  const at = new Date(Date.now() + 60_000).toISOString();
  const item = await store.create(input({ kind: "once", at }));
  expect((await store.list()).automations[0].nextRunAt).toBe(at);
  const [run] = await store.advanceDue(new Date(new Date(at).getTime() + 1000));
  expect(run).toMatchObject({ automationId: item.id, dueAt: at, status: "pending" });
  expect(await store.advanceDue(new Date(new Date(at).getTime() + 2000))).toEqual([]);
  await store.start(run.id, "task-one", "operation-one");
  await store.finish(run.id, "complete", "task complete");
  expect((await store.list()).runs[0]).toMatchObject({ taskId: "task-one", status: "complete" });
  expect((await store.list()).automations[0].nextRunAt).toBeNull();
});

test("recurring schedules coalesce missed runs and resume after pause", async () => {
  const store = new AutomationStore(await root());
  const startAt = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000).toISOString();
  const item = await store.create(input({ kind: "rrule", rule: "FREQ=HOURLY;INTERVAL=1", timeZone: "UTC", startAt }));
  const due = await store.advanceDue(new Date(new Date(startAt).getTime() + 3 * 3_600_000 + 1000));
  expect(due).toHaveLength(1);
  expect(due[0].missedCount).toBe(3);
  await store.update(item.id, { status: "PAUSED" });
  expect(await store.advanceDue(new Date(new Date(startAt).getTime() + 10 * 3_600_000))).toEqual([]);
  await store.finish(due[0].id, "failed", "test failure");
  const resumed = await store.update(item.id, { status: "ACTIVE" });
  expect(new Date(resumed.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
});

test("startup marks interrupted runs failed and does not rerun them", async () => {
  const store = new AutomationStore(await root());
  const item = await store.create(input({ kind: "once", at: new Date(Date.now() + 60_000).toISOString() }));
  const run = await store.runNow(item.id);
  await store.start(run.id, "task-one", "operation-one");
  await store.reconcile();
  expect((await store.list()).runs[0]).toMatchObject({ status: "failed", taskId: "task-one" });
  expect(await store.next()).toBeNull();
});
