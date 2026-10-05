/** Splits one CSV line into its fields. */
export function parseCsvLine(line: string): string[] {
  return line.split(",").map(field => field.trim());
}
