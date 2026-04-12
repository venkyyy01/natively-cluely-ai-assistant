// electron/conscious/ConsciousCache.ts
// Intelligent caching layer with LRU eviction and semantic similarity matching

import { createHash } from 'crypto';

export interface CacheEntry<T> {
  key: string;
  query: string;
  normalizedQuery: string;
  embedding?: number[];
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  ttlMs: number;
  phase?: string;
  tags: string[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  memoryBytes: number;
  hitRate: number;
}

export interface ConsciousCacheConfig {
  maxSize: number;
  defaultTtlMs: number;
  similarityThreshold: number;
  enableSemanticMatching: boolean;
  maxMemoryMB: number;
}

const DEFAULT_CONFIG: ConsciousCacheConfig = {
  maxSize: 100,
  defaultTtlMs: 5 * 60 * 1000, // 5 minutes
  similarityThreshold: 0.85,
  enableSemanticMatching: true,
  maxMemoryMB: 50,
};

export class ConsciousCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private config: ConsciousCacheConfig;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(config: Partial<ConsciousCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Normalize query for better cache matching
   */
  private normalizeQuery(query: string): string {
    return query
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .replace(/\b(a|an|the|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|must|shall|can|need|dare|ought|used|to|of|in|for|on|with|at|by|from|as|into|through|during|before|after|above|below|between|under|again|further|then|once|here|there|when|where|why|how|all|any|both|each|few|more|most|other|some|such|no|nor|not|only|own|same|so|than|too|very|just|now)\b/g, '')
      .trim();
  }

  /**
   * Generate cache key from query
   */
  private generateKey(query: string): string {
    const normalized = this.normalizeQuery(query);
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Find similar cached entries using semantic matching
   */
  private findSimilarEntry(query: string, embedding?: number[]): CacheEntry<T> | null {
    if (!this.config.enableSemanticMatching) return null;

    const normalizedQuery = this.normalizeQuery(query);
    let bestMatch: CacheEntry<T> | null = null;
    let bestScore = 0;

    for (const entry of this.cache.values()) {
      // Check exact normalized match first
      if (entry.normalizedQuery === normalizedQuery) {
        return entry;
      }

      // Check embedding similarity if available
      if (embedding && entry.embedding) {
        const similarity = this.cosineSimilarity(embedding, entry.embedding);
        if (similarity > this.config.similarityThreshold && similarity > bestScore) {
          bestScore = similarity;
          bestMatch = entry;
        }
      }

      // Check string similarity as fallback
      const stringSimilarity = this.calculateStringSimilarity(normalizedQuery, entry.normalizedQuery);
      if (stringSimilarity > this.config.similarityThreshold && stringSimilarity > bestScore) {
        bestScore = stringSimilarity;
        bestMatch = entry;
      }
    }

    return bestMatch;
  }

  /**
   * Calculate simple string similarity (Jaccard index)
   */
  private calculateStringSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(' '));
    const setB = new Set(b.split(' '));
    
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    
    return intersection.size / union.size;
  }

  /**
   * Check if entry is expired
   */
  private isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.timestamp > entry.ttlMs;
  }

  /**
   * Evict oldest entries (LRU)
   */
  private evictIfNeeded(): void {
    if (this.cache.size < this.config.maxSize) return;

    // Find oldest entry by lastAccessed
    let oldest: CacheEntry<T> | null = null;
    let oldestKey = '';

    for (const [key, entry] of this.cache) {
      if (!oldest || entry.lastAccessed < oldest.lastAccessed) {
        oldest = entry;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  /**
   * Get entry from cache
   */
  get(query: string, embedding?: number[]): T | null {
    // Try exact match first
    const key = this.generateKey(query);
    let entry = this.cache.get(key);

    // Try semantic match if no exact match
    if (!entry && this.config.enableSemanticMatching) {
      entry = this.findSimilarEntry(query, embedding);
    }

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(entry.key);
      this.stats.misses++;
      return null;
    }

    // Update access stats
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.stats.hits++;

    return entry.data;
  }

  /**
   * Set entry in cache
   */
  set(
    query: string,
    data: T,
    options: {
      ttlMs?: number;
      embedding?: number[];
      phase?: string;
      tags?: string[];
    } = {}
  ): void {
    this.evictIfNeeded();

    const key = this.generateKey(query);
    const normalizedQuery = this.normalizeQuery(query);

    const entry: CacheEntry<T> = {
      key,
      query,
      normalizedQuery,
      embedding: options.embedding,
      data,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
      ttlMs: options.ttlMs ?? this.config.defaultTtlMs,
      phase: options.phase,
      tags: options.tags ?? [],
    };

    this.cache.set(key, entry);
  }

  /**
   * Invalidate entries by tag
   */
  invalidateByTag(tag: string): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.tags.includes(tag)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate entries by phase
   */
  invalidateByPhase(phase: string): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.phase === phase) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const memoryBytes = JSON.stringify([...this.cache.values()]).length * 2; // Rough estimate

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      size: this.cache.size,
      memoryBytes,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }
}
