/** 金额工具。按两位小数、正数四舍五入（0.005 进位）处理。 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 元转分，用于展示。 */
export function toCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100);
}
