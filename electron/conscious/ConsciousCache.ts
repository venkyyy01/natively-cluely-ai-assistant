// electron/conscious/ConsciousCache.ts
// Intelligent caching layer with LRU eviction and semantic similarity matching

import { createHash } from "node:crypto";
import type {
	Cache,
	CacheGetOptions,
	CacheSetOptions,
	CacheStatsSnapshot,
	SemanticBindContext,
} from "../cache/Cache";
import { buildSemanticBindKeyPrefix } from "../cache/Cache";

export interface CacheEntry<T> {
	key: string;
	/** Prefix from `buildSemanticBindKeyPrefix` — scopes semantic search and eviction. */
	bindPrefix: string;
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

export class ConsciousCache<T> implements Cache<string, T> {
	private cache = new Map<string, CacheEntry<T>>();
	private config: ConsciousCacheConfig;
	private stats = {
		hits: 0,
		misses: 0,
		evictions: 0,
	};
	private currentMemoryBytes = 0;

	constructor(config: Partial<ConsciousCacheConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	private defaultBind(): SemanticBindContext {
		return { revision: 0, sessionId: "default" };
	}

	private resolveBind(options?: {
		bind?: SemanticBindContext;
	}): SemanticBindContext {
		return options?.bind ?? this.defaultBind();
	}

	private bindPrefixFor(bind: SemanticBindContext): string {
		return buildSemanticBindKeyPrefix(bind.revision, bind.sessionId);
	}

	private storageKey(query: string, bind: SemanticBindContext): string {
		return `${this.bindPrefixFor(bind)}${this.generateKey(query)}`;
	}

	private estimateEntryBytes(entry: CacheEntry<T>): number {
		const dataStr =
			typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data);
		let bytes =
			(entry.query.length +
				entry.normalizedQuery.length +
				dataStr.length +
				entry.key.length +
				entry.bindPrefix.length) *
			2;
		bytes += entry.embedding ? entry.embedding.length * 4 : 0;
		bytes += entry.tags.join(",").length * 2;
		return bytes + 128;
	}

	private evictEntryByStorageKey(storageKey: string): void {
		const entry = this.cache.get(storageKey);
		if (!entry) {
			return;
		}
		this.currentMemoryBytes -= this.estimateEntryBytes(entry);
		this.cache.delete(storageKey);
		this.stats.evictions++;
	}

	private evictLruForMemory(): void {
		const maxBytes = this.config.maxMemoryMB * 1024 * 1024;
		if (this.currentMemoryBytes <= maxBytes) {
			return;
		}

		let oldest: CacheEntry<T> | null = null;
		let oldestKey = "";

		for (const [key, entry] of this.cache) {
			if (!oldest || entry.lastAccessed < oldest.lastAccessed) {
				oldest = entry;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this.evictEntryByStorageKey(oldestKey);
		}
	}

	/**
	 * Normalize query for better cache matching
	 */
	private normalizeQuery(query: string): string {
		return query
			.toLowerCase()
			.trim()
			.replace(/\s+/g, " ")
			.replace(/[^\w\s]/g, "")
			.replace(
				/\b(a|an|the|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|must|shall|can|need|dare|ought|used|to|of|in|for|on|with|at|by|from|as|into|through|during|before|after|above|below|between|under|again|further|then|once|here|there|when|where|why|how|all|any|both|each|few|more|most|other|some|such|no|nor|not|only|own|same|so|than|too|very|just|now)\b/g,
				"",
			)
			.trim();
	}

	/**
	 * Generate cache key from query
	 */
	private generateKey(query: string): string {
		const normalized = this.normalizeQuery(query);
		return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
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
	private findSimilarEntry(
		query: string,
		embedding: number[] | undefined,
		bind: SemanticBindContext,
	): CacheEntry<T> | null {
		if (!this.config.enableSemanticMatching) return null;

		const normalizedQuery = this.normalizeQuery(query);
		const prefix = this.bindPrefixFor(bind);
		let bestMatch: CacheEntry<T> | null = null;
		let bestScore = 0;

		for (const entry of this.cache.values()) {
			if (entry.bindPrefix !== prefix) {
				continue;
			}
			// Check exact normalized match first
			if (entry.normalizedQuery === normalizedQuery) {
				return entry;
			}

			// Check embedding similarity if available
			if (embedding && entry.embedding) {
				const similarity = this.cosineSimilarity(embedding, entry.embedding);
				if (
					similarity > this.config.similarityThreshold &&
					similarity > bestScore
				) {
					bestScore = similarity;
					bestMatch = entry;
				}
			}

			// Check string similarity as fallback
			const stringSimilarity = this.calculateStringSimilarity(
				normalizedQuery,
				entry.normalizedQuery,
			);
			if (
				stringSimilarity > this.config.similarityThreshold &&
				stringSimilarity > bestScore
			) {
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
		const setA = new Set(a.split(" "));
		const setB = new Set(b.split(" "));

		const intersection = new Set([...setA].filter((x) => setB.has(x)));
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
	 * Evict oldest entries (LRU) by count
	 */
	private evictIfNeeded(): void {
		if (this.cache.size < this.config.maxSize) return;

		let oldest: CacheEntry<T> | null = null;
		let oldestKey = "";

		for (const [key, entry] of this.cache) {
			if (!oldest || entry.lastAccessed < oldest.lastAccessed) {
				oldest = entry;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this.evictEntryByStorageKey(oldestKey);
		}
	}

	/**
	 * Get entry from cache
	 */
	get(
		query: string,
		embeddingOrOptions?: number[] | CacheGetOptions,
	): T | null {
		let embedding: number[] | undefined;
		let bind = this.defaultBind();
		if (
			embeddingOrOptions &&
			typeof embeddingOrOptions === "object" &&
			!Array.isArray(embeddingOrOptions)
		) {
			embedding = embeddingOrOptions.embedding;
			if (embeddingOrOptions.bind) {
				bind = embeddingOrOptions.bind;
			}
		} else {
			embedding = embeddingOrOptions as number[] | undefined;
		}

		const storageKey = this.storageKey(query, bind);
		let entry = this.cache.get(storageKey);

		if (!entry && this.config.enableSemanticMatching) {
			const similar = this.findSimilarEntry(query, embedding, bind);
			entry = similar ?? undefined;
		}

		if (!entry) {
			this.stats.misses++;
			return null;
		}

		if (this.isExpired(entry)) {
			this.evictEntryByStorageKey(entry.key);
			this.stats.misses++;
			return null;
		}

		entry.accessCount++;
		entry.lastAccessed = Date.now();
		this.stats.hits++;

		return entry.data;
	}

	findSimilar(
		query: string,
		embedding: number[],
		bind: SemanticBindContext,
	): T | null {
		const hit = this.findSimilarEntry(query, embedding, bind);
		if (!hit || this.isExpired(hit)) {
			return null;
		}
		hit.accessCount++;
		hit.lastAccessed = Date.now();
		this.stats.hits++;
		return hit.data;
	}

	/**
	 * Set entry in cache
	 */
	set(
		query: string,
		data: T,
		options: CacheSetOptions & {
			phase?: string;
			tags?: string[];
		} = {},
	): void {
		const bind = this.resolveBind(options);
		const storageKey = this.storageKey(query, bind);
		const normalizedQuery = this.normalizeQuery(query);
		const bindPrefix = this.bindPrefixFor(bind);

		this.evictIfNeeded();

		const newEntry: CacheEntry<T> = {
			key: storageKey,
			bindPrefix,
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

		const newBytes = this.estimateEntryBytes(newEntry);
		const existing = this.cache.get(storageKey);
		if (existing) {
			this.currentMemoryBytes -= this.estimateEntryBytes(existing);
		}

		const maxBytes = this.config.maxMemoryMB * 1024 * 1024;
		while (
			this.cache.size > 0 &&
			this.currentMemoryBytes + newBytes > maxBytes
		) {
			const before = this.currentMemoryBytes;
			this.evictLruForMemory();
			if (this.currentMemoryBytes === before) {
				break;
			}
		}

		this.cache.set(storageKey, newEntry);
		this.currentMemoryBytes += newBytes;

		while (this.cache.size > 1 && this.currentMemoryBytes > maxBytes) {
			const before = this.currentMemoryBytes;
			this.evictLruForMemory();
			if (this.currentMemoryBytes === before) {
				break;
			}
		}
	}

	delete(query: string, options?: { bind?: SemanticBindContext }): boolean {
		const storageKey = this.storageKey(query, this.resolveBind(options));
		if (!this.cache.has(storageKey)) {
			return false;
		}
		this.evictEntryByStorageKey(storageKey);
		return true;
	}

	evictByPrefix(prefix: string): number {
		let count = 0;
		for (const k of [...this.cache.keys()]) {
			if (k.startsWith(prefix)) {
				this.evictEntryByStorageKey(k);
				count++;
			}
		}
		return count;
	}

	/**
	 * Invalidate entries by tag
	 */
	invalidateByTag(tag: string): number {
		let count = 0;
		for (const [key, entry] of this.cache) {
			if (entry.tags.includes(tag)) {
				this.evictEntryByStorageKey(key);
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
				this.evictEntryByStorageKey(key);
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
		this.currentMemoryBytes = 0;
		this.stats = { hits: 0, misses: 0, evictions: 0 };
	}

	/**
	 * Get cache statistics
	 */
	getStats(): CacheStatsSnapshot {
		const total = this.stats.hits + this.stats.misses;

		return {
			size: this.cache.size,
			memoryBytes: this.currentMemoryBytes,
			hits: this.stats.hits,
			misses: this.stats.misses,
			evictions: this.stats.evictions,
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
				this.evictEntryByStorageKey(key);
				count++;
			}
		}
		return count;
	}
}
