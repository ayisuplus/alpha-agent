import { expect, test } from "bun:test";
import { LRUCache } from "../src/lru";

test("the least recently used entry is evicted", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  expect(cache.has("a")).toBe(false);
  expect(cache.get("b")).toBe(2);
  expect(cache.get("c")).toBe(3);
  expect(cache.size).toBe(2);
});

test("reading an entry makes it recently used", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  expect(cache.get("a")).toBe(1);
  cache.set("c", 3);
  expect(cache.has("a")).toBe(true);
  expect(cache.has("b")).toBe(false);
});

test("updating an entry refreshes it without growing the cache", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10);
  cache.set("c", 3);
  expect(cache.get("a")).toBe(10);
  expect(cache.has("b")).toBe(false);
  expect(cache.size).toBe(2);
});

test("has does not change recency, and a zero capacity stores nothing", () => {
  const cache = new LRUCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  expect(cache.has("a")).toBe(true);
  cache.set("c", 3);
  expect(cache.has("a")).toBe(false);
  const empty = new LRUCache<string, number>(0);
  empty.set("x", 1);
  expect(empty.size).toBe(0);
  expect(empty.get("x")).toBeUndefined();
});
