/** Tiny in-process TTL cache with a size bound (oldest entries evicted first). */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: Promise<V>; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1_000,
  ) {}

  /** Returns the cached value or runs `load` once; concurrent callers share the same promise. */
  get(key: string, load: () => Promise<V>, now = Date.now()): Promise<V> {
    const hit = this.map.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = load();
    this.map.set(key, { value, expires: now + this.ttlMs });
    // Failed loads are not cached.
    value.catch(() => this.map.delete(key));
    if (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
    return value;
  }
}
