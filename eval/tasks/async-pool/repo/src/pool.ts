export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const [index, item] of items.entries()) {
    results[index] = await worker(item, index);
  }
  return results;
}
