import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { type CacheConfig, EnhancedCache } from "../cache/EnhancedCache";

describe("EnhancedCache", () => {
	let cache: EnhancedCache<string, string>;

	beforeEach(() => {
		const config: CacheConfig = {
			maxMemoryMB: 1,
			ttlMs: 1000,
			enableSemanticLookup: false,
		};
		cache = new EnhancedCache<string, string>(config);
	});

	it("should store and retrieve values", async () => {
		await cache.set("key1", "value1");
		const result = await cache.get("key1");
		assert.strictEqual(result, "value1");
	});

	it("should respect TTL expiration", async () => {
		await cache.set("key1", "value1");

		await new Promise((resolve) => setTimeout(resolve, 1100));

		const result = await cache.get("key1");
		assert.strictEqual(result, undefined);
	});

	it("should evict oldest entries on memory pressure", async () => {
		const config: CacheConfig = {
			maxMemoryMB: 0.001,
			ttlMs: 60000,
		};
		const smallCache = new EnhancedCache<string, string>(config);

		for (let i = 0; i < 100; i++) {
			await smallCache.set(`key${i}`, `value${i}`.repeat(100));
		}

		const oldest = await smallCache.get("key0");
		assert.strictEqual(oldest, undefined);
	});

	it("should support semantic similarity lookup within a binding domain", async () => {
		const config: CacheConfig = {
			maxMemoryMB: 10,
			ttlMs: 60000,
			enableSemanticLookup: true,
			similarityThreshold: 0.8,
		};
		const semanticCache = new EnhancedCache<string, string>(config);

		await semanticCache.set("rev1:query1", "answer1", [1, 0, 0]);

		const result = await semanticCache.get(
			"rev1:query2",
			[0.9, 0.1, 0],
			"rev1:",
		);
		assert.strictEqual(result, "answer1");
	});

	it("NAT-003: semantic lookup is partitioned by bindKeyPrefix and never bleeds across domains", async () => {
		const config: CacheConfig = {
			maxMemoryMB: 10,
			ttlMs: 60000,
			enableSemanticLookup: true,
			similarityThreshold: 0.8,
		};
		const semanticCache = new EnhancedCache<string, string>(config);

		// Two domains store identical embeddings under different prefixes.
		await semanticCache.set("rev1:query", "answer-from-rev1", [1, 0, 0]);
		await semanticCache.set("rev2:query", "answer-from-rev2", [1, 0, 0]);

		// A rev2 lookup with a near embedding must NEVER return rev1's value,
		// even though the embeddings are identical (audit A-3 / NAT-003).
		const result = await semanticCache.get(
			"rev2:other-query",
			[1, 0, 0],
			"rev2:",
		);
		assert.strictEqual(result, "answer-from-rev2");

		// And a lookup that forgets to pass a prefix must refuse semantic match.
		const unbounded = await semanticCache.get("rev2:other-query", [1, 0, 0]);
		assert.strictEqual(unbounded, undefined);
	});
});
