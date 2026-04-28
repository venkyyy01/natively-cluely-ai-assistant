/**
 * NAT-058 — unified cache contract (byte + count eviction, revision/session binding for semantic paths).
 */

/** Required for semantic lookup / eviction scoping so matches never cross revision or session. */
export interface SemanticBindContext {
  revision: number;
  sessionId: string;
}

/** Stable string prefix for embedding maps and `evictByPrefix`. */
export function buildSemanticBindKeyPrefix(revision: number, sessionId: string): string {
  const safeSession = sessionId.replace(/[|:]/g, '_');
  return `r:${revision}:s:${safeSession}:`;
}

export interface CacheGetOptions {
  embedding?: number[];
  /** When set, semantic lookup uses `buildSemanticBindKeyPrefix(bind.revision, bind.sessionId)`. */
  bind?: SemanticBindContext;
  /**
   * Legacy explicit prefix (must agree with `bind` if both provided — `bind` wins).
   * Prefer `bind` for new code.
   */
  bindKeyPrefix?: string;
}

export interface CacheSetOptions {
  embedding?: number[];
  ttlMs?: number;
  bind?: SemanticBindContext;
}

export interface CacheStatsSnapshot {
  size: number;
  memoryBytes: number;
  [key: string]: unknown;
}

/**
 * Shared cache surface for EnhancedCache, ConsciousCache, and future implementations.
 * `get` / `set` may be sync or async depending on implementation; callers should `await` where needed.
 */
export interface Cache<K, V> {
  get(key: K, options?: CacheGetOptions): Promise<V | undefined | null> | V | undefined | null;
  set(key: K, value: V, options?: CacheSetOptions | number[] | undefined): void | Promise<void>;
  delete(key: K, options?: { bind?: SemanticBindContext }): boolean;
  clear(): void;
  /** Remove all keys whose serialized form starts with `prefix` (e.g. semantic bind prefix). */
  evictByPrefix(prefix: string): number;
  getStats(): CacheStatsSnapshot;
  /** Optional explicit semantic path; implementations may also fold this into `get` with `embedding` + `bind`. */
  findSimilar?(
    query: string,
    embedding: number[],
    bind: SemanticBindContext,
  ): Promise<V | undefined | null> | V | undefined | null;
}
