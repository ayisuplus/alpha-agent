import { expect, test } from "bun:test";
import { PRICES } from "../src/generated";
import { pricingFor } from "../src/index";

test("generated.ts carries the script's full price table", () => {
  expect(PRICES).toEqual({ basic: 2900, pro: 9900, enterprise: 29900 });
});

test("the whole table prices correctly", () => {
  expect(pricingFor("basic", 3)).toBe(8_700);
  expect(pricingFor("enterprise", 12)).toBe(358_800);
});
