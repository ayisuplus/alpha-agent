import { expect, test } from "bun:test";
import { calculateTotal } from "../src/cart";

test("the discount applies before tax", () => {
  expect(calculateTotal({ items: [{ price: 19.99, quantity: 3 }], discountPercent: 10, taxRate: 0.06 })).toBe(57.21);
  expect(calculateTotal({ items: [{ price: 12.5, quantity: 2 }, { price: 3.3, quantity: 3 }], discountPercent: 15, taxRate: 0.13 })).toBe(33.52);
});

test("totals round half up to the cent on decimal amounts", () => {
  expect(calculateTotal({ items: [{ price: 1.005, quantity: 1 }], taxRate: 0 })).toBe(1.01);
  expect(calculateTotal({ items: [{ price: 2.675, quantity: 1 }], taxRate: 0 })).toBe(2.68);
  expect(calculateTotal({ items: [{ price: 0.1, quantity: 3 }], taxRate: 0 })).toBe(0.3);
  expect(calculateTotal({ items: [{ price: 99.99, quantity: 1 }], taxRate: 0.06 })).toBe(105.99);
});

test("an empty order costs nothing", () => {
  expect(calculateTotal({ items: [], discountPercent: 20, taxRate: 0.1 })).toBe(0);
});
