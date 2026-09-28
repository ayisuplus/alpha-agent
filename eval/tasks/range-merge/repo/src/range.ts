/** A half-open range [start, end). */
export interface Range {
  start: number;
  end: number;
}

/** Whether two ranges share at least one point. */
export function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Combines ranges that overlap into one. */
export function mergeRanges(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && overlaps(last, range)) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
