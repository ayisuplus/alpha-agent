import { expect, test } from "bun:test";
import { round2, toCents } from "../src/money";
import { total } from "../src/total";

test("总价保留两位小数，不再取整到元", () => {
  expect(total([19.99], 0.08125)).toBe(21.61);
  expect(total([0.5], 0)).toBe(0.5);
});

test("折扣先于计税，只做一次两位小数取整", () => {
  expect(total([123.45, 67.89], 0.03, 0.15)).toBe(167.52);
  expect(total([100], 0.03, 0.1)).toBe(92.7);
});

test("跨小数边界的订单总额正确", () => {
  expect(total([9.99, 0.01], 0.03)).toBe(10.3);
});

test("取整工具保持文档描述的行为", () => {
  expect(round2(21.6142)).toBe(21.61);
  expect(round2(1.005)).toBe(1.01);
  expect(toCents(21.6142)).toBe(2161);
});
