import { expect, test } from "bun:test";
import { applyDiscount, subtotal, total } from "../src/total";

test("子小计是各价格之和", () => {
  expect(subtotal([10, 2.5])).toBe(12.5);
});

test("折扣按比例作用在金额上", () => {
  expect(applyDiscount(100, 0.1)).toBe(90);
});

test("整元订单的总价保持整元", () => {
  expect(total([100], 0)).toBe(100);
});
