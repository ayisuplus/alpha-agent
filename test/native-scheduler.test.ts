import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeNextRun, nextCronRun, ScheduleStore, Scheduler, type Schedule } from "../src/native/scheduler";

const at = (iso: string) => new Date(iso);

describe("cron scheduling", () => {
  test("computes the next run for intervals and common cron shapes", () => {
    expect(computeNextRun({ kind: "interval", intervalMinutes: 30 }, at("2026-09-30T10:00:00Z"))?.toISOString()).toBe("2026-09-30T10:30:00.000Z");
    expect(computeNextRun({ kind: "interval", intervalMinutes: 0 }, at("2026-09-30T10:00:00Z"))).toBeNull();

    // 本地时钟构造：用本地时间断言本地语义。
    const from = new Date(2026, 8, 30, 10, 7, 0); // 2026-09-30 10:07 本地
    const quarter = nextCronRun("*/15 * * * *", from);
    expect(quarter?.getMinutes()).toBe(15);
    const nine = nextCronRun("0 9 * * *", from);
    expect(nine?.getHours()).toBe(9);
    expect(nine?.getMinutes()).toBe(0);
    const weekday = nextCronRun("0 9 * * 1-5", new Date(2026, 9, 3, 10, 0, 0)); // 周六
    expect(weekday).not.toBeNull();
    expect([1, 2, 3, 4, 5]).toContain(weekday!.getDay());
  });

  test("rejects malformed expressions", () => {
    expect(nextCronRun("99 * * * *", at("2026-09-30T10:00:00Z"))).toBeNull();
    expect(nextCronRun("* * * *", at("2026-09-30T10:00:00Z"))).toBeNull();
    expect(nextCronRun("*/0 * * * *", at("2026-09-30T10:00:00Z"))).toBeNull();
    expect(nextCronRun("a b c d e", at("2026-09-30T10:00:00Z"))).toBeNull();
    expect(computeNextRun({ kind: "cron", cron: "bad" }, at("2026-09-30T10:00:00Z"))).toBeNull();
  });
});

describe("schedule store", () => {
  test("persists schedules, validates input, and records runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "alpha-schedules-"));
    try {
      const store = new ScheduleStore(join(root, "data"));
      const created = await store.create({ name: "日报", prompt: "写日报", kind: "interval", intervalMinutes: 60, target: { kind: "new" } }, at("2026-09-30T10:00:00Z"));
      expect(created.nextRunAt).toBe("2026-09-30T11:00:00.000Z");
      expect((await store.list()).length).toBe(1);

      await expect(store.create({ name: "", prompt: "x", kind: "interval", intervalMinutes: 5 }, at("2026-09-30T10:00:00Z"))).rejects.toThrow("名称");
      await expect(store.create({ name: "x", prompt: "y", kind: "cron", cron: "bad" }, at("2026-09-30T10:00:00Z"))).rejects.toThrow("cron");
      await expect(store.create({ name: "x", prompt: "y", kind: "interval", intervalMinutes: 5, target: { kind: "session", sessionId: "nope" } }, at("2026-09-30T10:00:00Z"))).rejects.toThrow("会话");

      const updated = await store.update(created.id, { name: "日报", prompt: "写日报 v2", kind: "interval", intervalMinutes: 60 }, at("2026-09-30T10:30:00Z"));
      expect(updated.prompt).toBe("写日报 v2");
      await store.recordRun(created.id, "已投递", at("2026-09-30T11:00:00Z"));
      const after = (await store.list())[0];
      expect(after.lastResult).toBe("已投递");
      expect(after.nextRunAt).toBe("2026-09-30T12:00:00.000Z");

      await store.remove(created.id);
      expect((await store.list()).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("scheduler ticks", () => {
  test("fires due schedules once, skips disabled and future ones, and never stacks a running schedule", async () => {
    const root = await mkdtemp(join(tmpdir(), "alpha-scheduler-"));
    try {
      const store = new ScheduleStore(join(root, "data"));
      const now = at("2026-09-30T10:00:00Z");
      const due = await store.create({ name: "due", prompt: "p1", kind: "interval", intervalMinutes: 1, target: { kind: "new" } }, new Date(now.getTime() - 120_000));
      const future = await store.create({ name: "future", prompt: "p2", kind: "interval", intervalMinutes: 60, target: { kind: "new" } }, now);
      const disabled = await store.create({ name: "off", prompt: "p3", kind: "interval", intervalMinutes: 1, enabled: false, target: { kind: "new" } }, new Date(now.getTime() - 120_000));

      const delivered: string[] = [];
      let release: (() => void) | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let started: (() => void) | undefined;
      const startedSignal = new Promise<void>(resolve => { started = resolve; });
      const scheduler = new Scheduler(store, async (schedule: Schedule) => {
        delivered.push(schedule.name);
        started?.();
        if (schedule.name === "due") await gate;
        return "ok";
      }, () => now);

      const first = scheduler.tick();
      await startedSignal;
      await scheduler.tick(); // 上一次未完成：不叠加
      expect(delivered).toEqual(["due"]);
      release?.();
      await first;

      const after = (await store.list()).find(item => item.id === due.id);
      expect(after?.lastResult).toBe("ok");
      expect(after?.nextRunAt).toBe("2026-09-30T10:01:00.000Z");
      expect((await store.list()).find(item => item.id === future.id)?.lastRunAt).toBeNull();
      expect((await store.list()).find(item => item.id === disabled.id)?.lastRunAt).toBeNull();

      // 投递失败记为回执而不是异常外溢（时钟推进到下一次运行点后再触发）。
      const failing = new Scheduler(store, async () => { throw new Error("boom"); }, () => new Date(now.getTime() + 5 * 60_000));
      await failing.tick();
      expect((await store.list()).find(item => item.id === due.id)?.lastResult).toContain("boom");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
