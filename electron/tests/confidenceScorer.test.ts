// electron/tests/confidenceScorer.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { ConfidenceScorer } from "../conscious/ConfidenceScorer";
import { type ConversationThread, InterviewPhase } from "../conscious/types";

const createMockThread = (
	overrides: Partial<ConversationThread> = {},
): ConversationThread => ({
	id: "test-thread",
	status: "suspended",
	topic: "caching layer design",
	goal: "Design Redis caching",
	phase: "high_level_design",
	keyDecisions: ["Use Redis", "TTL-based expiry"],
	constraints: [],
	codeContext: { snippets: [], maxSnippets: 3, totalTokenBudget: 500 },
	createdAt: Date.now() - 60000,
	lastActiveAt: Date.now() - 5000,
	suspendedAt: Date.now() - 5000,
	ttlMs: 300000,
	resumeKeywords: ["caching", "redis", "cache", "layer"],
	turnCount: 5,
	tokenCount: 200,
	resumeCount: 0,
	...overrides,
});

test("ConfidenceScorer - should return high confidence for explicit resume markers", () => {
	const scorer = new ConfidenceScorer();
	const thread = createMockThread();
	const score = scorer.calculateResumeConfidence(
		"Let's go back to the caching layer",
		thread,
		"high_level_design",
	);
	assert.ok(score.total >= 0.55);
	assert.ok(score.explicitMarkers > 0);
});

test("ConfidenceScorer - should apply temporal decay to old threads", () => {
	const scorer = new ConfidenceScorer();
	const freshThread = createMockThread({ suspendedAt: Date.now() - 60000 });
	const oldThread = createMockThread({ suspendedAt: Date.now() - 240000 });

	const freshScore = scorer.calculateResumeConfidence(
		"caching",
		freshThread,
		"high_level_design",
	);
	const oldScore = scorer.calculateResumeConfidence(
		"caching",
		oldThread,
		"high_level_design",
	);

	assert.ok(freshScore.temporalDecay > oldScore.temporalDecay);
});

test("ConfidenceScorer - should give phase alignment bonus", () => {
	const scorer = new ConfidenceScorer();
	const thread = createMockThread({ phase: "high_level_design" });
	const alignedScore = scorer.calculateResumeConfidence(
		"caching",
		thread,
		"high_level_design",
	);
	const misalignedScore = scorer.calculateResumeConfidence(
		"caching",
		thread,
		"implementation",
	);

	assert.ok(alignedScore.phaseAlignment > misalignedScore.phaseAlignment);
});

test("ConfidenceScorer - should apply topic shift penalty", () => {
	const scorer = new ConfidenceScorer();
	const thread = createMockThread();
	const score = scorer.calculateResumeConfidence(
		"Let's move on to a different topic entirely",
		thread,
		"high_level_design",
	);
	assert.ok(score.topicShiftPenalty > 0);
});

test("ConfidenceScorer - should calculate BM25 score for keyword overlap", () => {
	const scorer = new ConfidenceScorer();
	const thread = createMockThread({
		resumeKeywords: ["caching", "redis", "layer"],
	});
	const score = scorer.calculateResumeConfidence(
		"redis caching layer",
		thread,
		"high_level_design",
	);
	assert.ok(score.bm25Score > 0);
});
