// node-backend/cache/EnhancedCache.ts

/**
 * EnhancedCache - Two-tier cache with LRU and semantic similarity.
 *
 * Features:
 * - LRU cache with TTL (exact key match)
 * - Semantic cache (embedding similarity)
 * - Cache key generation from prompt hash
 * - Hit rate tracking
 * - Automatic eviction
 */

export interface CacheResult<T = unknown> {
  /** The cached value */
  value: T;
  /** When this entry was created */
  createdAt: number;
  /** When this entry was last accessed */
  lastAccessed: number;
  /** Whether this was a semantic match */
  semanticMatch?: boolean;
  /** Similarity score if semantic match */
  similarity?: number;
}

export interface CacheEntry<T> {
  value: T;
  createdAt: number;
  lastAccessed: number;
  embedding?: number[];
}

export interface CacheStats {
  /** Total cache size */
  size: number;
  /** Maximum cache size */
  maxSize: number;
  /** Total hits */
  hits: number;
  /** Exact key matches */
  exactHits: number;
  /** Semantic matches */
  semanticHits: number;
  /** Total misses */
  misses: number;
  /** Hit rate percentage */
  hitRate: number;
  /** Number of evictions */
  evictions: number;
  /** Number of TTL expirations */
  expirations: number;
  /** Memory usage estimate (bytes) */
  memoryEstimate: number;
}

export interface EnhancedCacheConfig {
  /** Maximum number of entries */
  maxSize: number;
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Enable semantic lookup via embeddings */
  enableSemanticLookup?: boolean;
  /** Similarity threshold for semantic matches (0-1) */
  similarityThreshold?: number;
  /** Name for this cache (for logging) */
  name?: string;
}

const DEFAULT_CONFIG: Required<EnhancedCacheConfig> = {
  maxSize: 1000,
  ttlMs: 30 * 60 * 1000, // 30 minutes
  enableSemanticLookup: true,
  similarityThreshold: 0.85,
  name: 'cache',
};

export class EnhancedCache<K = string, V = unknown> {
  private lru = new Map<string, CacheEntry<V>>();
  private embeddings: Map<string, number[]> | null = null;
  private config: Required<EnhancedCacheConfig>;

  // Stats
  private stats = {
    hits: 0,
    exactHits: 0,
    semanticHits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0,
  };

  constructor(config?: Partial<EnhancedCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enableSemanticLookup) {
      this.embeddings = new Map();
    }

    // Periodic cleanup of expired entries
    setInterval(() => this.cleanupExpired(), 60000); // Every minute
  }

  /**
   * Get a value from cache.
   * Tries exact match first, then semantic match if enabled.
   */
  get(key: K, embedding?: number[]): CacheResult<V> | null {
    const stringKey = this.keyToString(key);

    // Try exact match first (fast path)
    const exact = this.lru.get(stringKey);
    if (exact && !this.isExpired(exact)) {
      this.touchEntry(stringKey, exact);
      this.stats.hits++;
      this.stats.exactHits++;
      return {
        value: exact.value,
        createdAt: exact.createdAt,
        lastAccessed: exact.lastAccessed,
        semanticMatch: false,
      };
    }

    // Remove if expired
    if (exact) {
      this.lru.delete(stringKey);
      this.embeddings?.delete(stringKey);
      this.stats.expirations++;
    }

    // Try semantic lookup if enabled and embedding provided
    if (this.config.enableSemanticLookup && embedding && this.embeddings) {
      const similar = this.findSimilar(embedding);
      if (similar) {
        this.stats.hits++;
        this.stats.semanticHits++;
        return similar;
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Set a value in cache.
   */
  set(key: K, value: V, embedding?: number[]): void {
    const stringKey = this.keyToString(key);

    // Evict if at capacity
    while (this.lru.size >= this.config.maxSize) {
      this.evictOldest();
    }

    const now = Date.now();
    this.lru.set(stringKey, {
      value,
      createdAt: now,
      lastAccessed: now,
      embedding,
    });

    if (this.config.enableSemanticLookup && embedding && this.embeddings) {
      this.embeddings.set(stringKey, embedding);
    }
  }

  /**
   * Check if key exists (without updating access time).
   */
  has(key: K): boolean {
    const stringKey = this.keyToString(key);
    const entry = this.lru.get(stringKey);
    return entry !== undefined && !this.isExpired(entry);
  }

  /**
   * Delete a key from cache.
   */
  delete(key: K): boolean {
    const stringKey = this.keyToString(key);
    this.embeddings?.delete(stringKey);
    return this.lru.delete(stringKey);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.lru.clear();
    this.embeddings?.clear();
    this.resetStats();
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    return {
      size: this.lru.size,
      maxSize: this.config.maxSize,
      hits: this.stats.hits,
      exactHits: this.stats.exactHits,
      semanticHits: this.stats.semanticHits,
      misses: this.stats.misses,
      hitRate: totalRequests > 0 ? this.stats.hits / totalRequests : 0,
      evictions: this.stats.evictions,
      expirations: this.stats.expirations,
      memoryEstimate: this.estimateMemoryUsage(),
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      exactHits: 0,
      semanticHits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  /**
   * Get all keys (for debugging).
   */
  keys(): string[] {
    return Array.from(this.lru.keys());
  }

  /**
   * Get cache size.
   */
  get size(): number {
    return this.lru.size;
  }

  // Private methods

  /**
   * Convert key to string for storage.
   */
  private keyToString(key: K): string {
    if (typeof key === 'string') {
      return key;
    }
    return JSON.stringify(key);
  }

  /**
   * Check if entry has expired.
   */
  private isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }

  /**
   * Update last accessed time and move to end of LRU.
   */
  private touchEntry(key: string, entry: CacheEntry<V>): void {
    entry.lastAccessed = Date.now();
    // Move to end by deleting and re-adding
    this.lru.delete(key);
    this.lru.set(key, entry);
  }

  /**
   * Evict oldest entry (first in Map).
   */
  private evictOldest(): void {
    const firstKey = this.lru.keys().next().value;
    if (firstKey !== undefined) {
      this.lru.delete(firstKey);
      this.embeddings?.delete(firstKey);
      this.stats.evictions++;
    }
  }

  /**
   * Find similar entry by embedding.
   */
  private findSimilar(queryEmbedding: number[]): CacheResult<V> | null {
    if (!this.embeddings) return null;

    let bestMatch: {
      key: string;
      similarity: number;
      entry: CacheEntry<V>;
    } | null = null;

    for (const [key, storedEmbedding] of this.embeddings) {
      const entry = this.lru.get(key);
      if (!entry || this.isExpired(entry)) continue;

      const similarity = this.cosineSimilarity(queryEmbedding, storedEmbedding);

      if (
        similarity >= this.config.similarityThreshold &&
        (!bestMatch || similarity > bestMatch.similarity)
      ) {
        bestMatch = { key, similarity, entry };
      }
    }

    if (bestMatch) {
      this.touchEntry(bestMatch.key, bestMatch.entry);
      return {
        value: bestMatch.entry.value,
        createdAt: bestMatch.entry.createdAt,
        lastAccessed: bestMatch.entry.lastAccessed,
        semanticMatch: true,
        similarity: bestMatch.similarity,
      };
    }

    return null;
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Clean up expired entries.
   */
  private cleanupExpired(): void {
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.lru) {
      if (this.isExpired(entry)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.lru.delete(key);
      this.embeddings?.delete(key);
      this.stats.expirations++;
    }
  }

  /**
   * Estimate memory usage in bytes.
   */
  private estimateMemoryUsage(): number {
    let total = 0;

    for (const [key, entry] of this.lru) {
      // Key size
      total += key.length * 2; // UTF-16

      // Value size (rough estimate)
      const valueStr = JSON.stringify(entry.value);
      total += valueStr.length * 2;

      // Embedding size (if present)
      if (entry.embedding) {
        total += entry.embedding.length * 8; // 64-bit floats
      }

      // Metadata overhead
      total += 100;
    }

    return total;
  }
}

/**
 * Generate a cache key from messages/prompt.
 */
export function generateCacheKey(
  messages: Array<{ role: string; content: string }>,
  model?: string
): string {
  const content = messages
    .map((m) => `${m.role}:${m.content}`)
    .join('|');

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  const prefix = model ? `${model}:` : '';
  return `${prefix}${hash.toString(36)}`;
}

// Default cache instances
export const responseCache = new EnhancedCache<string, string>({
  maxSize: 500,
  ttlMs: 60 * 60 * 1000, // 1 hour
  enableSemanticLookup: true,
  similarityThreshold: 0.9,
  name: 'response',
});

export const embeddingCache = new EnhancedCache<string, number[]>({
  maxSize: 2000,
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours
  enableSemanticLookup: false, // No semantic lookup for embeddings
  name: 'embedding',
});
