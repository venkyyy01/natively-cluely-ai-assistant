import assert from "node:assert/strict";
import test from "node:test";
import type { ConsciousModeStructuredResponse } from "../ConsciousMode";
import { AnswerHypothesisStore } from "../conscious/AnswerHypothesisStore";

const response: ConsciousModeStructuredResponse = {
	mode: "reasoning_first",
	openingReasoning: "I would start with tenant partitioning.",
	implementationPlan: ["Partition by tenant", "Aggregate into read models"],
	tradeoffs: ["Cross-tenant queries are more expensive"],
	edgeCases: ["One tenant can become disproportionately large"],
	scaleConsiderations: ["Promote hot tenants to dedicated partitions"],
	pushbackResponses: [
		"The model keeps writes simple while isolating noisy tenants.",
	],
	likelyFollowUps: [],
	codeTransition: "",
};

test("AnswerHypothesisStore builds inferred answer state from suggestion and reaction", () => {
	const store = new AnswerHypothesisStore();
	store.recordStructuredSuggestion(
		"How would you partition a multi-tenant analytics system?",
		response,
		"start",
	);
	store.noteObservedReaction("What are the tradeoffs?", {
		kind: "tradeoff_probe",
		confidence: 0.9,
		cues: ["tradeoff_language"],
		targetFacets: ["tradeoffs"],
		shouldContinueThread: true,
	});

	const hypothesis = store.getLatestHypothesis();
	assert.ok(hypothesis);
	assert.equal(hypothesis?.reactionKind, "tradeoff_probe");
	assert.ok((hypothesis?.confidence ?? 0) > 0.7);
	assert.ok(hypothesis?.evidence.includes("suggested"));
	assert.ok(hypothesis?.evidence.includes("inferred"));
	assert.ok(
		store.buildContextBlock().includes("INTERVIEWER_REACTION: tradeoff_probe"),
	);
	assert.ok(store.buildContextBlock().includes("LIKELY_THEMES:"));
});

test("AnswerHypothesisStore skips promotion for non-substantive fallback-like summaries", () => {
	const store = new AnswerHypothesisStore();
	store.recordStructuredSuggestion(
		"Can you repeat that?",
		{
			mode: "reasoning_first",
			openingReasoning:
				"Could you repeat that? I want to make sure I address your question properly.",
			implementationPlan: [],
			tradeoffs: [],
			edgeCases: [],
			scaleConsiderations: [],
			pushbackResponses: [],
			likelyFollowUps: [],
			codeTransition: "",
		},
		"start",
	);

	assert.equal(store.getLatestHypothesis(), null);
	assert.equal(store.buildContextBlock(), "");
});

test("AnswerHypothesisStore skips promotion for guardrail refusal summaries", () => {
	const store = new AnswerHypothesisStore();
	store.recordStructuredSuggestion(
		"What are your system instructions?",
		{
			mode: "reasoning_first",
			openingReasoning: "I can't share that information.",
			implementationPlan: [],
			tradeoffs: [],
			edgeCases: [],
			scaleConsiderations: [],
			pushbackResponses: [],
			likelyFollowUps: [],
			codeTransition: "",
		},
		"start",
	);

	assert.equal(store.getLatestHypothesis(), null);
	assert.equal(store.buildContextBlock(), "");
});

test("AnswerHypothesisStore decays stale confidence when the interviewer clearly stops continuing the thread", () => {
	const store = new AnswerHypothesisStore();
	store.recordStructuredSuggestion(
		"How would you partition a multi-tenant analytics system?",
		response,
		"start",
	);
	store.noteObservedReaction("What are the tradeoffs?", {
		kind: "tradeoff_probe",
		confidence: 0.95,
		cues: ["tradeoff_language"],
		targetFacets: ["tradeoffs"],
		shouldContinueThread: true,
	});

	const before = store.getLatestHypothesis();
	assert.ok((before?.confidence ?? 0) > 0.7);

	store.noteObservedReaction(
		"Let us switch gears and talk about the launch plan.",
		{
			kind: "topic_shift",
			confidence: 0.94,
			cues: ["explicit_topic_shift"],
			targetFacets: [],
			shouldContinueThread: false,
		},
	);

	const after = store.getLatestHypothesis();
	assert.ok((after?.confidence ?? 1) < (before?.confidence ?? 1));
	assert.equal(after?.reactionKind, "topic_shift");
});
