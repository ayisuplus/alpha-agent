import { round2 } from "./money";

export function subtotal(prices: number[]): number {
  return prices.reduce((sum, price) => sum + price, 0);
}

export function applyDiscount(amount: number, rate: number): number {
  return amount * (1 - rate);
}

/** 总价：先按折扣算小计，再计税，最后保留两位小数。 */
export function total(prices: number[], taxRate: number, discountRate = 0): number {
  return Math.round(applyDiscount(subtotal(prices), discountRate) * (1 + taxRate));
}

export { round2 };
