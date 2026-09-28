import { expect, test } from "bun:test";
import { mergeRanges, overlaps } from "../src/range";

test("clearly overlapping ranges overlap", () => {
  expect(overlaps({ start: 1, end: 5 }, { start: 3, end: 8 })).toBe(true);
  expect(mergeRanges([{ start: 1, end: 5 }, { start: 3, end: 8 }])).toEqual([{ start: 1, end: 8 }]);
});
