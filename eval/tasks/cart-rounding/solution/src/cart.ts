export interface Item {
  price: number;
  quantity: number;
}

export interface Order {
  items: Item[];
  /** Percentage off, e.g. 10 for 10%. */
  discountPercent?: number;
  /** Tax rate, e.g. 0.06 for 6%. */
  taxRate: number;
}

/** Rounds a decimal amount half up to the cent, using its shortest decimal form so 1.005 rounds to 1.01. */
function roundCents(amount: number): number {
  const [whole, fraction = ""] = Math.abs(amount).toFixed(10).split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0")) + (Number(fraction[2] ?? "0") >= 5 ? 1n : 0n);
  return (amount < 0 ? -1 : 1) * Number(cents) / 100;
}

/** Order total in yuan: discount first, then tax, rounded half up to the cent. */
export function calculateTotal(order: Order): number {
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const discounted = subtotal * (100 - (order.discountPercent ?? 0)) / 100;
  return roundCents(discounted * (1 + order.taxRate));
}
