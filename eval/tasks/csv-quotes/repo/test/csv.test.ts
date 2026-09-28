import { expect, test } from "bun:test";
import { parseCsvLine } from "../src/csv";

test("plain fields split on commas", () => {
  expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
});
