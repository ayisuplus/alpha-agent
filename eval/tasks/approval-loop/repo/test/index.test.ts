import { expect, test } from "bun:test";
import { pricingFor } from "../src/index";

test("pricingFor multiplies the monthly price", () => {
  expect(pricingFor("pro", 12)).toBe(118_800);
});

test("an unknown sku is an error", () => {
  expect(() => pricingFor("ghost")).toThrow("unknown sku");
});
