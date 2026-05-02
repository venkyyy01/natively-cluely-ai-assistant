import assert from "node:assert/strict";
import test from "node:test";

import { ConsciousThreadStore } from "../conscious/ConsciousThreadStore";
import { ThreadDirector } from "../conscious/ThreadDirector";

const minimalResponse = {
	mode: "reasoning_first" as const,
	openingReasoning: "Short reasoning.",
	implementationPlan: [] as string[],
	tradeoffs: [] as string[],
	edgeCases: [] as string[],
	scaleConsiderations: [] as string[],
	pushbackResponses: [] as string[],
	likelyFollowUps: [] as string[],
	codeTransition: "",
};

test("NAT-055: ThreadDirector keeps design and reasoning active thread ids aligned", () => {
	const store = new ConsciousThreadStore();
	const director = new ThreadDirector(store);

	store
		.getThreadManager()
		.createThread("Design a distributed cache", "high_level_design");
	store.recordConsciousResponse(
		"How would you design a cache?",
		minimalResponse,
		"start",
	);

	director.assertDesignReasoningInvariant();
	const v = director.getViews();
	assert.ok(v.design.activeThreadId);
	assert.equal(v.design.activeThreadId, v.reasoning.activeThreadId);
});

test("NAT-055: resetThread emits thread:reset with reason", () => {
	const store = new ConsciousThreadStore();
	const director = new ThreadDirector(store);
	let seen: string | null = null;
	director.subscribe("thread:reset", (p) => {
		seen = p.reason;
	});
	director.resetThread("unit_test");
	assert.equal(seen, "unit_test");
});

test("NAT-055: continue updates reasoning threadId if design thread is still active", () => {
	const store = new ConsciousThreadStore();
	const director = new ThreadDirector(store);

	store
		.getThreadManager()
		.createThread("Rate limiting topic", "high_level_design");
	store.recordConsciousResponse(
		"How would you rate limit?",
		minimalResponse,
		"start",
	);
	store.recordConsciousResponse(
		"What about burst traffic?",
		minimalResponse,
		"continue",
	);

	director.assertDesignReasoningInvariant();
	assert.equal(
		store.getActiveReasoningThread()?.threadId,
		store.getThreadManager().getActiveThread()?.id,
	);
});
