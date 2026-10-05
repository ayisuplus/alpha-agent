export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length || limit < 1) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed: unknown = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length && failed === null) {
      const index = cursor++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { failed ??= error; }
    }
  });
  await Promise.all(runners);
  if (failed !== null) throw failed;
  return results;
}
