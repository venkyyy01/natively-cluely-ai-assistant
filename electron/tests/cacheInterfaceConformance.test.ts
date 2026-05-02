import assert from "node:assert/strict";
import test from "node:test";

import type { Cache } from "../cache/Cache";
import { buildSemanticBindKeyPrefix } from "../cache/Cache";
import { EnhancedCache } from "../cache/EnhancedCache";
import { ConsciousCache } from "../conscious/ConsciousCache";

test("NAT-058: EnhancedCache implements Cache and evictByPrefix removes scoped keys", async () => {
	const cache: Cache<string, string> = new EnhancedCache<string, string>({
		maxMemoryMB: 10,
		ttlMs: 60_000,
		enableSemanticLookup: false,
	});

	cache.set("p1:a", "A");
	cache.set("p1:b", "B");
	cache.set("p2:c", "C");

	assert.equal(cache.evictByPrefix("p1:"), 2);
	assert.equal((await cache.get("p2:c")) ?? null, "C");
	assert.equal(await cache.get("p1:a"), undefined);
});

test("NAT-058: EnhancedCache get accepts bind context for semantic prefix", async () => {
	const cache = new EnhancedCache<string, string>({
		maxMemoryMB: 10,
		ttlMs: 60_000,
		enableSemanticLookup: true,
		similarityThreshold: 0.8,
	});

	const bind = { revision: 3, sessionId: "sess|1" };
	const prefix = buildSemanticBindKeyPrefix(bind.revision, bind.sessionId);
	cache.set(`${prefix}q1`, "hit", [1, 0, 0]);

	const out = await cache.get(`${prefix}q2`, {
		embedding: [0.95, 0.05, 0],
		bind,
	});
	assert.equal(out, "hit");
});

test("NAT-058: ConsciousCache enforces maxMemoryMB under large entries", () => {
	const cache = new ConsciousCache<string>({
		maxSize: 100,
		maxMemoryMB: 1,
		defaultTtlMs: 60_000,
		enableSemanticMatching: false,
		similarityThreshold: 0.85,
	});

	const chunk = "x".repeat(180_000);
	cache.set("q1", chunk);
	cache.set("q2", chunk);
	cache.set("q3", chunk);

	const stats = cache.getStats();
	const maxBytes = 1 * 1024 * 1024;
	assert.ok(
		stats.memoryBytes <= maxBytes + 256 * 1024,
		"tracked bytes stay bounded by maxMemoryMB with headroom for estimate error",
	);
	assert.ok(
		stats.size < 3,
		"at least one LRU eviction for memory should drop an entry",
	);
});

test("NAT-058: ConsciousCache semantic search respects bind partition", () => {
	const cache = new ConsciousCache<string>({
		maxSize: 50,
		maxMemoryMB: 50,
		defaultTtlMs: 60_000,
		enableSemanticMatching: true,
		similarityThreshold: 0.5,
	});

	const bindA = { revision: 1, sessionId: "a" };
	const bindB = { revision: 2, sessionId: "a" };

	cache.set("hello world", "from-A", { bind: bindA, embedding: [1, 0, 0] });
	cache.set("hello world", "from-B", { bind: bindB, embedding: [1, 0, 0] });

	assert.equal(
		cache.get("hello world", { bind: bindA, embedding: [1, 0, 0] }),
		"from-A",
	);
	assert.equal(cache.findSimilar("hello there", [1, 0, 0], bindB), "from-B");
});
