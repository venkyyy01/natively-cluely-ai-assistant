import test from 'node:test';
import assert from 'node:assert/strict';

import { EnhancedCache } from '../cache/EnhancedCache';

// NAT-024 — `EnhancedCache.delete(key)` and `EnhancedCacheAdapter.delete(key)`
// must remove a single entry only. Historically, the adapter's `delete`
// called `enhancedCache.clear()`, wiping every other entry too — a P0
// cache-coherence bug (audit P-14). These tests pin down the correct
// per-key contract on both layers and guard against regression.

test('EnhancedCache.delete removes only the requested entry, leaves others', () => {
  const cache = new EnhancedCache<string, string>({
    maxMemoryMB: 4,
    ttlMs: 60_000,
  });

  cache.set('alpha', 'A');
  cache.set('beta', 'B');
  cache.set('gamma', 'C');

  const removed = cache.delete('beta');

  assert.equal(removed, true, 'delete returns true for an existing key');
  assert.equal(cache.getStats().size, 2, 'two entries remain after single delete');
});

test('EnhancedCache.delete on a missing key returns false and keeps cache intact', async () => {
  const cache = new EnhancedCache<string, string>({
    maxMemoryMB: 4,
    ttlMs: 60_000,
  });

  cache.set('alpha', 'A');

  const removed = cache.delete('does-not-exist');

  assert.equal(removed, false, 'delete returns false for a missing key');
  assert.equal(cache.getStats().size, 1);
  assert.equal(await cache.get('alpha'), 'A', 'existing entries are untouched');
});

test('EnhancedCache.delete also removes the embedding for the same key', async () => {
  const cache = new EnhancedCache<string, string>({
    maxMemoryMB: 4,
    ttlMs: 60_000,
    enableSemanticLookup: true,
    similarityThreshold: 0.5,
  });

  // Two entries in the same bind domain so a semantic miss really proves
  // the embedding was removed (and not just a false-negative threshold).
  const aliceEmbedding = [1, 0, 0];
  const bobEmbedding = [0.95, 0.05, 0]; // very close to alice
  cache.set('prefetch:r1:alice', 'alice-payload', aliceEmbedding);
  cache.set('prefetch:r1:bob', 'bob-payload', bobEmbedding);

  // Sanity: semantic lookup with a near-alice query finds something.
  const before = await cache.get('prefetch:r1:missing-key', [1, 0, 0], 'prefetch:r1:');
  assert.ok(before !== undefined, 'semantic lookup hits before delete');

  cache.delete('prefetch:r1:alice');
  cache.delete('prefetch:r1:bob');

  const after = await cache.get('prefetch:r1:missing-key', [1, 0, 0], 'prefetch:r1:');
  assert.equal(
    after,
    undefined,
    'semantic lookup misses once both embeddings are removed — embedding was deleted alongside the entry',
  );
});

test('EnhancedCacheAdapter.delete preserves siblings (regression: P-14 used to clear)', async () => {
  // The factory's default flags have `useEnhancedCache: true`, so the
  // returned adapter is the EnhancedCacheAdapter we want to exercise.
  const { createOptimizedCache } = await import('../cache/CacheFactory');
  const { setOptimizationFlagsForTesting } = await import('../config/optimizations');
  setOptimizationFlagsForTesting({ useEnhancedCache: true });

  const cache = createOptimizedCache<string, string>('per-key-delete-test', 60_000);
  cache.set('a', 'A');
  cache.set('b', 'B');
  cache.set('c', 'C');

  const removed = cache.delete('b');

  assert.equal(removed, true, 'delete reports success for an existing key');
  assert.equal(cache.get('a'), 'A', 'sibling A survives');
  assert.equal(cache.get('b'), undefined, 'B is gone');
  assert.equal(cache.get('c'), 'C', 'sibling C survives');
});

test('EnhancedCacheAdapter.clear still wipes everything when explicitly called', async () => {
  const { createOptimizedCache } = await import('../cache/CacheFactory');
  const { setOptimizationFlagsForTesting } = await import('../config/optimizations');
  setOptimizationFlagsForTesting({ useEnhancedCache: true });

  const cache = createOptimizedCache<string, string>('clear-test', 60_000);
  cache.set('a', 'A');
  cache.set('b', 'B');

  cache.clear();

  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), undefined);
});
