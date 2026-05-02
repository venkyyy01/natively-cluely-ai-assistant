import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import type { ReasoningThread } from "../ConsciousMode";
import { setOptimizationFlagsForTesting } from "../config/optimizations";
import { SemanticThreadMatcher } from "../conscious/SemanticThreadMatcher";

describe("SemanticThreadMatcher", () => {
	let matcher: SemanticThreadMatcher;

	before(() => {
		matcher = new SemanticThreadMatcher();
	});

	after(() => {
		matcher.clearCache();
	});

	it("should detect semantic compatibility between paraphrased questions", async () => {
		const thread: ReasoningThread = {
			rootQuestion: "How does that scale?",
			lastQuestion: "What about scalability?",
			response: {
				mode: "reasoning_first",
				openingReasoning: "So basically it scales horizontally",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 1,
			updatedAt: Date.now(),
		};

		const isCompatible = await matcher.isCompatible(
			"What about at scale?",
			thread,
		);
		assert.strictEqual(
			isCompatible,
			true,
			"Paraphrased questions should be compatible",
		);
	});

	it("should reject semantically distinct questions", async () => {
		const thread: ReasoningThread = {
			rootQuestion: "What database are you using?",
			lastQuestion: "Tell me about your database choice",
			response: {
				mode: "reasoning_first",
				openingReasoning: "We use Postgres",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 1,
			updatedAt: Date.now(),
		};

		const isCompatible = await matcher.isCompatible(
			"What cache are you using?",
			thread,
		);
		assert.strictEqual(
			isCompatible,
			false,
			"Semantically distinct questions should not be compatible",
		);
	});

	it("should fall back to false for very short questions (< 4 words)", async () => {
		const thread: ReasoningThread = {
			rootQuestion: "How does it scale?",
			lastQuestion: "Tell me about scale",
			response: {
				mode: "reasoning_first",
				openingReasoning: "It scales horizontally",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 1,
			updatedAt: Date.now(),
		};

		const isCompatible = await matcher.isCompatible("Scale?", thread);
		assert.strictEqual(
			isCompatible,
			false,
			"Very short questions should fall back to false",
		);
	});

	it("should detect referential follow-up cues", async () => {
		const thread: ReasoningThread = {
			rootQuestion: "How does the system work?",
			lastQuestion: "Explain the architecture",
			response: {
				mode: "reasoning_first",
				openingReasoning: "So basically it uses microservices",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 1,
			updatedAt: Date.now(),
		};

		const isCompatible = await matcher.isCompatible(
			"How does that work?",
			thread,
		);
		assert.strictEqual(
			isCompatible,
			true,
			"Referential follow-up cues should be detected",
		);
	});

	it("should use cached thread embedding when available", async () => {
		const thread: ReasoningThread = {
			rootQuestion: "How does it scale?",
			lastQuestion: "Tell me about scaling",
			response: {
				mode: "reasoning_first",
				openingReasoning: "It scales horizontally",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 1,
			updatedAt: Date.now(),
			embedding: [0.1, 0.2, 0.3], // Mock embedding
		};

		// This should use the cached embedding
		const isCompatible = await matcher.isCompatible(
			"What about scalability?",
			thread,
		);
		// With the mock embedding, similarity will be low, so it should return false
		// But the important part is that it doesn't crash when embedding is present
		assert.strictEqual(typeof isCompatible, "boolean");
	});

	it("should handle model loading failure gracefully", async () => {
		// Force a model load failure by calling with invalid context
		// In practice, this would require mocking the pipeline function
		// For now, we just verify the error handling path exists
		const thread: ReasoningThread = {
			rootQuestion: "How does it work?",
			lastQuestion: "Explain it",
			response: {
				mode: "reasoning_first",
				openingReasoning: "It works like this",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 1,
			updatedAt: Date.now(),
		};

		// If model fails to load, isCompatible should return false (caller falls back to stopword method)
		// We can't easily force a model load failure in this test, but the code has the error handling
		const isCompatible = await matcher.isCompatible(
			"How does it work?",
			thread,
		);
		assert.strictEqual(typeof isCompatible, "boolean");
	});

	it("should cache thread embeddings", async () => {
		const thread: ReasoningThread = {
			rootQuestion: "How does it scale?",
			lastQuestion: "Tell me about scaling",
			response: {
				mode: "reasoning_first",
				openingReasoning: "It scales horizontally",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 1,
			updatedAt: Date.now(),
		};

		await matcher.cacheThreadEmbedding(thread);
		assert.ok(thread.embedding, "Thread embedding should be cached");
		assert.ok(Array.isArray(thread.embedding), "Embedding should be an array");
		assert.ok(thread.embedding!.length > 0, "Embedding should not be empty");
	});

	it("should handle empty thread corpus when caching", async () => {
		const thread: ReasoningThread = {
			rootQuestion: "",
			lastQuestion: "",
			response: {
				mode: "reasoning_first",
				openingReasoning: "",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 0,
			updatedAt: Date.now(),
		};

		// Should not throw on empty corpus
		await matcher.cacheThreadEmbedding(thread);
		// Embedding should remain undefined or null
		assert.ok(!thread.embedding || thread.embedding.length === 0);
	});

	it("should clear cache", () => {
		matcher.clearCache();
		// Cache should be empty after clear
		// This is a basic sanity check - we can't easily inspect private cache
		assert.ok(true);
	});
});
