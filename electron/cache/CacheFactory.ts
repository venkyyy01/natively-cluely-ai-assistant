import { isOptimizationActive, getOptimizationFlags } from '../config/optimizations';
import { EnhancedCache } from './EnhancedCache';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export interface OptimizedCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, ttlMs?: number): void;
  delete(key: K): boolean;
  has(key: K): boolean;
  clear(): void;
  getWithTTL?(key: K): { value: V; expiresAt: number } | undefined;
}

class MapCache<K, V> implements OptimizedCache<K, V> {
  private cache: Map<string, { expiresAt: number; value: V }> = new Map();
  private serializer: (key: K) => string;
  private sweepInterval: NodeJS.Timeout;

  constructor(serializer?: (key: K) => string) {
    this.serializer = serializer || ((k: K) => typeof k === 'string' ? k : JSON.stringify(k));
    this.sweepInterval = setInterval(() => this.sweep(), 60000);
    this.sweepInterval.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  get(key: K): V | undefined {
    const stringKey = this.serializer(key);
    const entry = this.cache.get(stringKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(stringKey);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number = 5 * 60 * 1000): void {
    const stringKey = this.serializer(key);
    this.cache.set(stringKey, {
      expiresAt: Date.now() + ttlMs,
      value,
    });
  }

  delete(key: K): boolean {
    const stringKey = this.serializer(key);
    return this.cache.delete(stringKey);
  }

  has(key: K): boolean {
    const stringKey = this.serializer(key);
    const entry = this.cache.get(stringKey);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(stringKey);
      return false;
    }
    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  getWithTTL(key: K): { value: V; expiresAt: number } | undefined {
    const stringKey = this.serializer(key);
    return this.cache.get(stringKey);
  }
}

class EnhancedCacheAdapter<K, V> implements OptimizedCache<K, V> {
  private enhancedCache: EnhancedCache<K, V>;
  private ttlMs: number;
  private syncCache: Map<string, { value: V; expiresAt: number }>;
  private sweepInterval: NodeJS.Timeout;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    const flags = getOptimizationFlags();
    this.ttlMs = ttlMs;
    this.enhancedCache = new EnhancedCache<K, V>({
      maxMemoryMB: flags.maxCacheMemoryMB,
      ttlMs: ttlMs,
      enableSemanticLookup: false,
    });
    this.syncCache = new Map();
    this.sweepInterval = setInterval(() => this.sweep(), 60000);
    this.sweepInterval.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.syncCache.entries()) {
      if (entry.expiresAt <= now) {
        this.syncCache.delete(key);
      }
    }
  }

  get(key: K): V | undefined {
    const stringKey = this.serializeKey(key);
    const syncEntry = this.syncCache.get(stringKey);
    if (syncEntry && syncEntry.expiresAt > Date.now()) {
      return syncEntry.value;
    }
    if (syncEntry) {
      this.syncCache.delete(stringKey);
    }
    return undefined;
  }

  set(key: K, value: V, ttlMs?: number): void {
    const stringKey = this.serializeKey(key);
    const effectiveTtl = ttlMs || this.ttlMs;
    this.syncCache.set(stringKey, {
      value,
      expiresAt: Date.now() + effectiveTtl,
    });
    this.enhancedCache.set(key, value);
  }

  delete(key: K): boolean {
    const stringKey = this.serializeKey(key);
    this.syncCache.delete(stringKey);
    this.enhancedCache.clear();
    return true;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.syncCache.clear();
    this.enhancedCache.clear();
  }

  private serializeKey(key: K): string {
    return typeof key === 'string' ? key : JSON.stringify(key);
  }
}

export function createOptimizedCache<K, V>(
  cacheName: string,
  defaultTtlMs: number = 5 * 60 * 1000
): OptimizedCache<K, V> {
  if (isOptimizationActive('useEnhancedCache')) {
    console.log(`[CacheFactory] Using EnhancedCache for ${cacheName}`);
    return new EnhancedCacheAdapter<K, V>(defaultTtlMs);
  }
  return new MapCache<K, V>();
}

export function getSystemPromptCache(): OptimizedCache<string, string> {
  return createOptimizedCache('system-prompt', 10 * 60 * 1000);
}

export function getResponseCache(): OptimizedCache<string, string> {
  return createOptimizedCache('response', 2 * 60 * 1000);
}

export function getFinalPayloadCache<T>(): OptimizedCache<string, T> {
  return createOptimizedCache<string, T>('final-payload', 5 * 60 * 1000);
}
