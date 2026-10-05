import { PRICES } from "./generated";

export function pricingFor(sku: string, months = 1): number {
  const unit = PRICES[sku];
  if (unit === undefined) throw new Error(`unknown sku: ${sku}`);
  return unit * months;
}
