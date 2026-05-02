import assert from "node:assert/strict";
import test from "node:test";

import { EmbeddingPipeline } from "../rag/EmbeddingPipeline";
import { EmbeddingProviderResolver } from "../rag/EmbeddingProviderResolver";
import { LocalEmbeddingProvider } from "../rag/providers/LocalEmbeddingProvider";

function createPipeline() {
	const db = {
		prepare: () => ({
			get: (): null => null,
			run: (): void => {},
		}),
	} as any;

	const vectorStore = {
		getIncompatibleMeetingsCount: (): number => 0,
	} as any;

	return new EmbeddingPipeline(db, vectorStore);
}

test("EmbeddingPipeline keeps the local fallback lazy when a primary provider is available", async () => {
	const originalResolve = EmbeddingProviderResolver.resolve;
	const originalIsAvailable = LocalEmbeddingProvider.prototype.isAvailable;
	const primaryProvider = {
		name: "remote",
		dimensions: 1536,
		embed: async () => [1],
		isAvailable: async () => true,
	} as any;
	let localAvailabilityChecks = 0;

	EmbeddingProviderResolver.resolve = async () => primaryProvider;
	LocalEmbeddingProvider.prototype.isAvailable =
		async function mockIsAvailable() {
			localAvailabilityChecks += 1;
			return true;
		};

	try {
		const pipeline = createPipeline();
		await pipeline.initialize({ openaiKey: "key" });

		assert.equal(localAvailabilityChecks, 0);
		assert.equal((pipeline as any).fallbackProvider?.name, "local");
		assert.equal((pipeline as any).provider, primaryProvider);
	} finally {
		EmbeddingProviderResolver.resolve = originalResolve;
		LocalEmbeddingProvider.prototype.isAvailable = originalIsAvailable;
	}
});

test("EmbeddingPipeline only loads the local fallback after primary provider resolution fails", async () => {
	const originalResolve = EmbeddingProviderResolver.resolve;
	const originalIsAvailable = LocalEmbeddingProvider.prototype.isAvailable;
	let localAvailabilityChecks = 0;

	EmbeddingProviderResolver.resolve = async () => {
		throw new Error("primary provider unavailable");
	};
	LocalEmbeddingProvider.prototype.isAvailable =
		async function mockIsAvailable() {
			localAvailabilityChecks += 1;
			return true;
		};

	try {
		const pipeline = createPipeline();
		await pipeline.initialize({});

		assert.equal(localAvailabilityChecks, 1);
		assert.equal((pipeline as any).provider?.name, "local");
	} finally {
		EmbeddingProviderResolver.resolve = originalResolve;
		LocalEmbeddingProvider.prototype.isAvailable = originalIsAvailable;
	}
});
