/** A half-open range [start, end). */
export interface Range {
  start: number;
  end: number;
}

/** Whether two ranges share at least one point. */
export function overlaps(a: Range, b: Range): boolean {
  if (a.start >= a.end || b.start >= b.end) return false;
  return a.start < b.end && b.start < a.end;
}

/** Sorts the ranges and combines those that overlap or touch; empty ranges are dropped. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter(range => range.start < range.end).map(range => ({ ...range })).sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}
