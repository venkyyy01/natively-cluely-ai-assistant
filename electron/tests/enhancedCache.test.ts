import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { EnhancedCache, CacheConfig } from '../cache/EnhancedCache';

describe('EnhancedCache', () => {
  let cache: EnhancedCache<string, string>;

  beforeEach(() => {
    const config: CacheConfig = {
      maxMemoryMB: 1,
      ttlMs: 1000,
      enableSemanticLookup: false,
    };
    cache = new EnhancedCache<string, string>(config);
  });

  it('should store and retrieve values', async () => {
    await cache.set('key1', 'value1');
    const result = await cache.get('key1');
    assert.strictEqual(result, 'value1');
  });

  it('should respect TTL expiration', async () => {
    await cache.set('key1', 'value1');

    await new Promise(resolve => setTimeout(resolve, 1100));

    const result = await cache.get('key1');
    assert.strictEqual(result, undefined);
  });

  it('should evict oldest entries on memory pressure', async () => {
    const config: CacheConfig = {
      maxMemoryMB: 0.001,
      ttlMs: 60000,
    };
    const smallCache = new EnhancedCache<string, string>(config);

    for (let i = 0; i < 100; i++) {
      await smallCache.set(`key${i}`, `value${i}`.repeat(100));
    }

    const oldest = await smallCache.get('key0');
    assert.strictEqual(oldest, undefined);
  });

  it('should support semantic similarity lookup', async () => {
    const config: CacheConfig = {
      maxMemoryMB: 10,
      ttlMs: 60000,
      enableSemanticLookup: true,
      similarityThreshold: 0.8,
    };
    const semanticCache = new EnhancedCache<string, string>(config);

    await semanticCache.set('query1', 'answer1', [1, 0, 0]);

    const result = await semanticCache.get('query2', [0.9, 0.1, 0]);
    assert.strictEqual(result, 'answer1');
  });
});
