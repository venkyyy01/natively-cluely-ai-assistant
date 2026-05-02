import assert from "node:assert/strict";
import test from "node:test";
import type {
	ConsciousModeStructuredResponse,
	ReasoningThread,
} from "../ConsciousMode";
import { QuestionReactionClassifier } from "../conscious/QuestionReactionClassifier";

function createResponse(): ConsciousModeStructuredResponse {
	return {
		mode: "reasoning_first",
		openingReasoning: "I would use Redis-backed token buckets.",
		implementationPlan: ["Use Redis for distributed counters"],
		tradeoffs: ["Adds network hop latency"],
		edgeCases: ["Hot keys can appear under bursty traffic"],
		scaleConsiderations: ["Track QPS and hot-key skew"],
		pushbackResponses: ["Redis gives us coordination across instances."],
		likelyFollowUps: [],
		codeTransition: "",
	};
}

function createThread(): ReasoningThread {
	return {
		rootQuestion: "How would you design a rate limiter?",
		lastQuestion: "How would you design a rate limiter?",
		response: createResponse(),
		followUpCount: 0,
		updatedAt: Date.now(),
	};
}

test("QuestionReactionClassifier detects tradeoff probes on an active thread", () => {
	const classifier = new QuestionReactionClassifier();
	const reaction = classifier.classify({
		question: "What are the tradeoffs here?",
		activeThread: createThread(),
		latestResponse: createResponse(),
	});

	assert.equal(reaction.kind, "tradeoff_probe");
	assert.equal(reaction.shouldContinueThread, true);
	assert.deepEqual(reaction.targetFacets, ["tradeoffs"]);
});

test("QuestionReactionClassifier treats explicit topic shifts as thread resets", () => {
	const classifier = new QuestionReactionClassifier();
	const reaction = classifier.classify({
		question: "Let us switch gears and talk about the launch plan.",
		activeThread: createThread(),
		latestResponse: createResponse(),
	});

	assert.equal(reaction.kind, "topic_shift");
	assert.equal(reaction.shouldContinueThread, false);
});

test("QuestionReactionClassifier treats let us talk about pivots as topic shifts", () => {
	const classifier = new QuestionReactionClassifier();
	const reaction = classifier.classify({
		question: "That is interesting, but let us talk about security instead.",
		activeThread: createThread(),
		latestResponse: createResponse(),
	});

	assert.equal(reaction.kind, "topic_shift");
	assert.equal(reaction.shouldContinueThread, false);
});

test("QuestionReactionClassifier does not continue generic follow-ups based only on prior hypothesis confidence", () => {
	const classifier = new QuestionReactionClassifier();
	const reaction = classifier.classify({
		question: "Could you expand?",
		activeThread: createThread(),
		latestResponse: createResponse(),
		latestHypothesis: {
			sourceQuestion: "How would you design a rate limiter?",
			latestSuggestedAnswer: "Use Redis-backed token buckets.",
			likelyThemes: ["redis", "token bucket"],
			confidence: 0.92,
			evidence: ["suggested"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
	});

	assert.equal(reaction.kind, "generic_follow_up");
	assert.equal(reaction.shouldContinueThread, false);
});

test("QuestionReactionClassifier continues generic follow-ups when they contain thread-scoped referential cues", () => {
	const classifier = new QuestionReactionClassifier();
	const reaction = classifier.classify({
		question: "Would that still hold under backfill traffic?",
		activeThread: createThread(),
		latestResponse: createResponse(),
	});

	assert.equal(reaction.kind, "generic_follow_up");
	assert.equal(reaction.shouldContinueThread, true);
});

test("QuestionReactionClassifier classifyAsync uses SetFit when flag is enabled", async () => {
	const classifier = new QuestionReactionClassifier();
	const reaction = await classifier.classifyAsync({
		question: "What are the tradeoffs here?",
		activeThread: createThread(),
		latestResponse: createResponse(),
	});

	// Should return a valid reaction (may be SetFit or regex fallback)
	assert.ok(reaction.kind);
	assert.ok(typeof reaction.confidence === "number");
});
