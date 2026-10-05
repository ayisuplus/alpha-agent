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

/** Order total in yuan. */
export function calculateTotal(order: Order): number {
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const taxed = subtotal * (1 + order.taxRate);
  const discount = order.discountPercent ? (taxed * order.discountPercent) / 100 : 0;
  return Math.floor((taxed - discount) * 100) / 100;
}
