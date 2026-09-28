import { expect, test } from "bun:test";
import { mapLimit } from "../src/pool";

test("results keep the input order", async () => {
  const results = await mapLimit([3, 1, 2], 2, async item => {
    await Bun.sleep((4 - item) * 10);
    return item * 10;
  });
  expect(results).toEqual([30, 10, 20]);
});

test("empty input resolves an empty array", async () => {
  expect(await mapLimit([], 3, async () => 1)).toEqual([]);
});
