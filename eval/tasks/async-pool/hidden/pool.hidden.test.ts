import { expect, test } from "bun:test";
import { mapLimit } from "../src/pool";

test("at most `limit` workers run at once, and the concurrency is actually used", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async item => {
    running++;
    peak = Math.max(peak, running);
    await Bun.sleep(20);
    running--;
    return item;
  });
  expect(peak).toBe(2);
  expect(results).toEqual([1, 2, 3, 4, 5, 6]);
});

test("results stay in input order even when later items finish first", async () => {
  const results = await mapLimit([3, 1, 2], 3, async item => {
    await Bun.sleep((4 - item) * 15);
    return item;
  });
  expect(results).toEqual([3, 1, 2]);
});

test("a rejection stops scheduling and rejects with that error", async () => {
  const started: number[] = [];
  const failure = new Error("worker failed");
  await expect(mapLimit([1, 2, 3, 4], 1, async item => {
    started.push(item);
    if (item === 2) throw failure;
    return item;
  })).rejects.toBe(failure);
  expect(started).toEqual([1, 2]);
});

test("a limit below one resolves an empty array", async () => {
  expect(await mapLimit([1, 2], 0, async item => item)).toEqual([]);
  expect(await mapLimit([1, 2], -1, async item => item)).toEqual([]);
});
