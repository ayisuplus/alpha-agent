import { expect, test } from "bun:test";
import { LRUCache } from "../src/lru";

test("stored values can be read back", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  expect(cache.get("a")).toBe(1);
});
