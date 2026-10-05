/** A cache that keeps at most `capacity` entries. */
export class LRUCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const newest = [...this.entries.keys()].at(-1)!;
      this.entries.delete(newest);
    }
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }
}
