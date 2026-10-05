import { expect, test } from "bun:test";
import { mergeRanges, overlaps } from "../src/range";

test("ranges that only touch do not overlap", () => {
  expect(overlaps({ start: 1, end: 3 }, { start: 3, end: 5 })).toBe(false);
  expect(overlaps({ start: 3, end: 5 }, { start: 1, end: 3 })).toBe(false);
});

test("an empty range overlaps nothing", () => {
  expect(overlaps({ start: 2, end: 2 }, { start: 0, end: 5 })).toBe(false);
  expect(overlaps({ start: 0, end: 5 }, { start: 4, end: 4 })).toBe(false);
});

test("merging sorts first and joins touching ranges", () => {
  expect(mergeRanges([{ start: 6, end: 9 }, { start: 1, end: 3 }, { start: 3, end: 5 }])).toEqual([{ start: 1, end: 5 }, { start: 6, end: 9 }]);
  expect(mergeRanges([{ start: 10, end: 12 }, { start: 1, end: 11 }])).toEqual([{ start: 1, end: 12 }]);
});

test("merging drops empty ranges and leaves the input untouched", () => {
  const input = [{ start: 4, end: 4 }, { start: 5, end: 7 }, { start: 1, end: 2 }];
  expect(mergeRanges(input)).toEqual([{ start: 1, end: 2 }, { start: 5, end: 7 }]);
  expect(input).toEqual([{ start: 4, end: 4 }, { start: 5, end: 7 }, { start: 1, end: 2 }]);
  expect(mergeRanges([])).toEqual([]);
});
