import { expect, test } from "bun:test";
import { calculateTotal } from "../src/cart";

test("a plain order sums its items", () => {
  expect(calculateTotal({ items: [{ price: 10, quantity: 2 }], taxRate: 0 })).toBe(20);
});
