import { createHash } from 'crypto';

const SYSTEM_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
const FINAL_PAYLOAD_CACHE_TTL_MS = 15 * 1000;
const RESPONSE_CACHE_TTL_MS = 1500;
const SYSTEM_PROMPT_CACHE_MAX = 50;
const FINAL_PAYLOAD_CACHE_MAX = 20;
const RESPONSE_CACHE_MAX = 100;
const IN_FLIGHT_RESPONSE_CACHE_MAX = 10;

export class PromptCache {
  private systemPromptCache = new Map<string, { expiresAt: number; value: string }>();
  private finalPayloadCache = new Map<string, { expiresAt: number; value: any }>();
  private responseCache = new Map<string, { expiresAt: number; value: string }>();
  private inFlightResponseCache = new Map<string, Promise<string>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupExpiredCaches(), 60_000);
    this.cleanupInterval.unref?.();
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.systemPromptCache.clear();
    this.finalPayloadCache.clear();
    this.responseCache.clear();
    this.inFlightResponseCache.clear();
  }

  private hashValue(value: unknown): string {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return createHash('sha256').update(serialized).digest('hex');
  }

  private cloneCacheValue<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value;
    return JSON.parse(JSON.stringify(value));
  }

  private getCacheKey(...parts: Array<string | undefined>): string {
    return parts.map(part => part ?? '').join('::');
  }

  private readCacheEntry<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return this.cloneCacheValue(entry.value);
  }

  private writeCacheEntry<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string, value: T, ttlMs: number): T {
    cache.set(key, {
      expiresAt: Date.now() + ttlMs,
      value: this.cloneCacheValue(value),
    });
    this.enforceCacheLimit(cache, this.getCacheLimit(cache));
    return this.cloneCacheValue(value);
  }

  private getCacheLimit(cache: Map<string, unknown>): number {
    if (cache === this.systemPromptCache) return SYSTEM_PROMPT_CACHE_MAX;
    if (cache === this.finalPayloadCache) return FINAL_PAYLOAD_CACHE_MAX;
    if (cache === this.responseCache) return RESPONSE_CACHE_MAX;
    return RESPONSE_CACHE_MAX;
  }

  private enforceCacheLimit<T>(cache: Map<string, T>, maxEntries: number): void {
    while (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }

  private cleanupExpiredCaches(): void {
    const now = Date.now();
    for (const cache of [this.systemPromptCache, this.finalPayloadCache, this.responseCache]) {
      for (const [key, value] of cache.entries()) {
        if (value.expiresAt <= now) {
          cache.delete(key);
        }
      }
    }
  }

  async withSystemPromptCache(
    provider: string,
    model: string,
    basePrompt: string,
    builder: () => Promise<string> | string,
    aiResponseLanguage: string,
    ttlMs: number = SYSTEM_PROMPT_CACHE_TTL_MS,
  ): Promise<string> {
    const cacheKey = this.getCacheKey('system-prompt', provider, model, this.hashValue(basePrompt), aiResponseLanguage);
    const cached = this.readCacheEntry(this.systemPromptCache, cacheKey);
    if (cached !== undefined) return cached;
    const built = await builder();
    return this.writeCacheEntry(this.systemPromptCache, cacheKey, built, ttlMs);
  }

  async withFinalPayloadCache<T>(
    provider: string,
    model: string,
    systemPromptHash: string,
    payloadHash: string,
    builder: () => Promise<T> | T,
    ttlMs: number = FINAL_PAYLOAD_CACHE_TTL_MS,
  ): Promise<T> {
    const cacheKey = this.getCacheKey('final-payload', provider, model, systemPromptHash, payloadHash);
    const cached = this.readCacheEntry(this.finalPayloadCache, cacheKey);
    if (cached !== undefined) return cached;
    const built = await builder();
    return this.writeCacheEntry(this.finalPayloadCache, cacheKey, built, ttlMs);
  }

  async withResponseCache(
    provider: string,
    model: string,
    systemPromptHash: string,
    payloadHash: string,
    request: () => Promise<string>,
    ttlMs: number = RESPONSE_CACHE_TTL_MS,
  ): Promise<string> {
    const cacheKey = this.getCacheKey('response', provider, model, systemPromptHash, payloadHash);
    const cached = this.readCacheEntry(this.responseCache, cacheKey);
    if (cached !== undefined) return cached;

    const inFlight = this.inFlightResponseCache.get(cacheKey);
    if (inFlight) return inFlight;

    if (this.inFlightResponseCache.size >= IN_FLIGHT_RESPONSE_CACHE_MAX) {
      const oldestKey = this.inFlightResponseCache.keys().next().value;
      if (oldestKey !== undefined) this.inFlightResponseCache.delete(oldestKey);
    }

    const pending = request()
      .then(result => {
        this.writeCacheEntry(this.responseCache, cacheKey, result, ttlMs);
        this.inFlightResponseCache.delete(cacheKey);
        return result;
      })
      .catch(error => {
        this.inFlightResponseCache.delete(cacheKey);
        throw error;
      });

    this.inFlightResponseCache.set(cacheKey, pending);
    return pending;
  }
}
