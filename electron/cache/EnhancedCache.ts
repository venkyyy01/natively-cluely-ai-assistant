import { Metrics } from '../runtime/Metrics';

export interface CacheConfig {
  maxMemoryMB: number;
  ttlMs: number;
  enableSemanticLookup?: boolean;
  similarityThreshold?: number;
}

interface CacheEntry<T> {
  value: T;
  createdAt: number;
  lastAccessed: number;
  sizeBytes: number;
}

export class EnhancedCache<K, V> {
  private cache: Map<string, CacheEntry<V>> = new Map();
  private embeddings: Map<string, number[]> | null = null;
  private currentMemoryBytes: number = 0;

  constructor(private config: CacheConfig) {
    if (config.enableSemanticLookup) {
      this.embeddings = new Map();
    }
  }

  async get(key: K, embedding?: number[], bindKeyPrefix?: string): Promise<V | undefined> {
    const stringKey = this.serialize(key);

    const entry = this.cache.get(stringKey);
    if (entry) {
      if (this.isExpired(entry)) {
        this.evict(stringKey);
        return undefined;
      }

      entry.lastAccessed = Date.now();
      this.cache.delete(stringKey);
      this.cache.set(stringKey, entry);

      return entry.value;
    }

    if (this.config.enableSemanticLookup && embedding && this.embeddings) {
      // NAT-003 / audit A-3: refuse to walk the embedding map across binding
      // domains. A semantic match must only be considered against entries that
      // share the caller's bindKeyPrefix (e.g. `prefetch:${transcriptRevision}:`).
      // If the caller forgot to pass a prefix, skip semantic lookup entirely
      // rather than risking a cross-revision / cross-context bleed.
      if (typeof bindKeyPrefix !== 'string' || bindKeyPrefix.length === 0) {
        console.warn('[EnhancedCache] semantic lookup skipped: no bindKeyPrefix provided');
        return undefined;
      }
      return this.findSimilar(embedding, bindKeyPrefix);
    }

    return undefined;
  }

  set(key: K, value: V, embedding?: number[]): void {
    const stringKey = this.serialize(key);
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
    const valueSizeBytes = this.estimateSize(valueStr);
    const embeddingSizeBytes = embedding ? embedding.length * 4 : 0;
    const totalSizeBytes = valueSizeBytes + embeddingSizeBytes;

    while (this.currentMemoryBytes + totalSizeBytes > this.config.maxMemoryMB * 1024 * 1024) {
      if (!this.evictOldest()) {
        break;
      }
    }

    const existing = this.cache.get(stringKey);
    if (existing) {
      this.currentMemoryBytes -= existing.sizeBytes;
    }

    const entry: CacheEntry<V> = {
      value,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      sizeBytes: totalSizeBytes,
    };

    this.cache.set(stringKey, entry);
    this.currentMemoryBytes += totalSizeBytes;

    if (this.config.enableSemanticLookup && embedding && this.embeddings) {
      this.embeddings.set(stringKey, embedding);
    }
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }

  private evictOldest(): boolean {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.evict(oldestKey);
      return true;
    }

    return false;
  }

  private evict(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentMemoryBytes -= entry.sizeBytes;
      this.cache.delete(key);

      if (this.embeddings) {
        this.embeddings.delete(key);
      }
    }
  }

  private findSimilar(embedding: number[], bindKeyPrefix: string): V | undefined {
    if (!this.embeddings || !this.config.similarityThreshold) {
      return undefined;
    }

    let bestMatch: { key: string; similarity: number } | null = null;

    for (const [key, storedEmbedding] of this.embeddings) {
      // Hard partition: only consider entries that live in the caller's
      // binding domain. Without this filter, a near-embedding from a stale
      // transcript revision (or an unrelated request) could be returned in
      // place of the caller's data. See audit A-3 / NAT-003.
      if (!key.startsWith(bindKeyPrefix)) {
        continue;
      }

      const similarity = this.cosineSimilarity(embedding, storedEmbedding);

      if (similarity >= this.config.similarityThreshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { key, similarity };
        }
      }
    }

    if (bestMatch) {
      const entry = this.cache.get(bestMatch.key);
      if (entry && !this.isExpired(entry)) {
        return entry.value;
      }
    }

    return undefined;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private serialize(key: K): string {
    if (typeof key === 'string') {
      return key;
    }
    return JSON.stringify(key);
  }

  private estimateSize(value: string): number {
    return value.length * 2;
  }

  /**
   * Remove a single entry (and its embedding, if any) without disturbing
   * the rest of the cache.
   *
   * Added for NAT-024 / audit P-14: the legacy `EnhancedCacheAdapter.delete`
   * path used to call `clear()` here, which silently wiped *every* cached
   * entry whenever any caller asked to invalidate one key — a P0 cache
   * coherence bug. Callers that still want a full wipe must call `clear()`
   * explicitly.
   *
   * Returns true when an entry existed and was removed, false otherwise,
   * matching the contract of `Map.prototype.delete`.
   */
  delete(key: K): boolean {
    const stringKey = this.serialize(key);
    if (!this.cache.has(stringKey)) {
      // Best-effort cleanup of an orphaned embedding (should not happen,
      // but the maps drifting apart would silently leak memory).
      this.embeddings?.delete(stringKey);
      return false;
    }
    this.evict(stringKey);
    return true;
  }

  clear(): void {
    Metrics.counter('cache.global_clear_calls');
    this.cache.clear();
    this.embeddings?.clear();
    this.currentMemoryBytes = 0;
  }

  getStats(): { size: number; memoryBytes: number } {
    return {
      size: this.cache.size,
      memoryBytes: this.currentMemoryBytes,
    };
  }
}
