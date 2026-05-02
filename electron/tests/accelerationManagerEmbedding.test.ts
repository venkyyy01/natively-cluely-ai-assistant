import assert from "node:assert/strict";
import test from "node:test";
import {
	getEmbeddingProvider,
	setEmbeddingProvider,
} from "../cache/ParallelContextAssembler";
import {
	DEFAULT_OPTIMIZATION_FLAGS,
	setOptimizationFlagsForTesting,
} from "../config/optimizations";
import { AccelerationManager } from "../services/AccelerationManager";

test("AccelerationManager registers a real local embedding provider when ANE embeddings are unavailable", async () => {
	setOptimizationFlagsForTesting({
		...DEFAULT_OPTIMIZATION_FLAGS,
		accelerationEnabled: true,
		useANEEmbeddings: false,
	});

	const manager = new AccelerationManager();
	(manager as any).localEmbeddingProvider = {
		embed: async (text: string) => [text.length, text.length + 1],
	};

	try {
		await manager.initialize();

		const provider = getEmbeddingProvider();
		assert.equal(provider?.isInitialized(), true);
		assert.deepEqual(await provider?.embed("hello"), [5, 6]);
	} finally {
		setEmbeddingProvider(null);
		setOptimizationFlagsForTesting({ ...DEFAULT_OPTIMIZATION_FLAGS });
	}
});

test("AccelerationManager can detach and reattach the embedding runtime without keeping the global provider active", async () => {
	setOptimizationFlagsForTesting({
		...DEFAULT_OPTIMIZATION_FLAGS,
		accelerationEnabled: true,
		useANEEmbeddings: false,
	});

	const manager = new AccelerationManager();
	(manager as any).localEmbeddingProvider = {
		embed: async (text: string) => [text.length],
	};

	try {
		await manager.initialize();
		assert.ok(getEmbeddingProvider());

		manager.deactivate();
		assert.equal(getEmbeddingProvider(), null);

		manager.activate();
		assert.ok(getEmbeddingProvider());
		assert.deepEqual(await getEmbeddingProvider()?.embed("hi"), [2]);
	} finally {
		setEmbeddingProvider(null);
		setOptimizationFlagsForTesting({ ...DEFAULT_OPTIMIZATION_FLAGS });
	}
});
