import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/lib/ttl-cache.js';

describe('TtlCache', () => {
  it('shares in-flight loads and expires entries', async () => {
    const cache = new TtlCache<number>(1_000);
    let calls = 0;
    const load = async () => ++calls;
    const [a, b] = await Promise.all([cache.get('k', load, 0), cache.get('k', load, 10)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await cache.get('k', load, 999)).toBe(1);
    expect(await cache.get('k', load, 1_001)).toBe(2);
  });

  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(1_000);
    await expect(cache.get('k', () => Promise.reject(new Error('boom')), 0)).rejects.toThrow('boom');
    await Promise.resolve();
    expect(await cache.get('k', async () => 7, 1)).toBe(7);
  });

  it('evicts the oldest entry beyond the size bound', async () => {
    const cache = new TtlCache<string>(60_000, 2);
    await cache.get('a', async () => 'a1', 0);
    await cache.get('b', async () => 'b1', 0);
    await cache.get('c', async () => 'c1', 0);
    expect(await cache.get('a', async () => 'a2', 1)).toBe('a2');
    expect(await cache.get('c', async () => 'c2', 1)).toBe('c1');
  });
});
