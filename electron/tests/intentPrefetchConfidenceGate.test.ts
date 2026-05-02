import assert from "node:assert/strict";
import test from "node:test";

import { ConsciousAccelerationOrchestrator } from "../conscious/ConsciousAccelerationOrchestrator";
import { ConsciousIntentService } from "../conscious/ConsciousIntentService";
import type { IntentResult } from "../llm/IntentClassifier";

const baseQuery =
	"Walk me through how you would design a session storage layer.";

function buildOrchestrator(
	intent: IntentResult,
): ConsciousAccelerationOrchestrator {
	const orchestrator = new ConsciousAccelerationOrchestrator({
		budgetScheduler: { shouldAdmitSpeculation: () => true },
		intentClassifier: async () => intent,
	});
	orchestrator.setEnabled(true);
	return orchestrator;
}

async function primePrefetch(
	orchestrator: ConsciousAccelerationOrchestrator,
	revision: number,
): Promise<void> {
	orchestrator.noteTranscriptText("interviewer", baseQuery);
	orchestrator.updateTranscriptSegments(
		[{ speaker: "interviewer", text: baseQuery, timestamp: Date.now() }],
		revision,
	);
	await (
		orchestrator as unknown as { maybePrefetchIntent: () => Promise<void> }
	).maybePrefetchIntent();
}

test("NAT-L3: medium-confidence non-general prefetched intent IS stored", async () => {
	const orchestrator = buildOrchestrator({
		intent: "deep_dive",
		confidence: 0.55,
		answerShape: "",
	});

	await primePrefetch(orchestrator, 1);

	const stored = orchestrator.getPrefetchedIntent(baseQuery, 1);
	assert.equal(stored?.intent, "deep_dive");
	assert.equal(stored?.confidence, 0.55);
});

test("NAT-L3: very-low-confidence prefetched intent is NOT stored", async () => {
	const orchestrator = buildOrchestrator({
		intent: "deep_dive",
		confidence: 0.4,
		answerShape: "",
	});

	await primePrefetch(orchestrator, 1);

	assert.equal(orchestrator.getPrefetchedIntent(baseQuery, 1), null);
});

test("NAT-005: general-intent prefetch (any confidence) is NOT stored", async () => {
	const orchestrator = buildOrchestrator({
		intent: "general",
		confidence: 0.99,
		answerShape: "",
	});

	await primePrefetch(orchestrator, 2);

	assert.equal(orchestrator.getPrefetchedIntent(baseQuery, 2), null);
});

test("NAT-005: above-threshold prefetched intent IS stored", async () => {
	const strong: IntentResult = {
		intent: "deep_dive",
		confidence: 0.91,
		answerShape: "Walk through the design.",
	};
	const orchestrator = buildOrchestrator(strong);

	await primePrefetch(orchestrator, 3);

	const stored = orchestrator.getPrefetchedIntent(baseQuery, 3);
	assert.equal(stored?.intent, "deep_dive");
	assert.equal(stored?.confidence, 0.91);
});

test("NAT-005: ConsciousIntentService.resolve re-classifies on weak prefetched intent", async () => {
	const service = new ConsciousIntentService();
	let classifyCalls = 0;
	const fresh: IntentResult = {
		intent: "behavioral",
		confidence: 0.93,
		answerShape: "Tell one grounded story.",
	};

	const result = await service.resolve({
		lastInterviewerTurn: baseQuery,
		preparedTranscript: baseQuery,
		assistantResponseCount: 0,
		startedAt: Date.now(),
		hardBudgetMs: 1_000,
		isLikelyGeneralIntent: false,
		classifyIntent: async () => {
			classifyCalls += 1;
			return fresh;
		},
		prefetchedIntent: {
			intent: "general",
			confidence: 0.4,
			answerShape: "",
			provider: "test-prefetch",
			retryCount: 0,
		},
	});

	assert.equal(
		classifyCalls,
		1,
		"live classifier should be invoked when prefetch is uncertain",
	);
	assert.equal(result.intentResult.intent, "behavioral");
	assert.equal(result.intentResult.confidence, 0.93);
	assert.equal(result.timedOut, false);
});

test("NAT-005: ConsciousIntentService.resolve uses strong prefetched intent without re-classification", async () => {
	const service = new ConsciousIntentService();
	let classifyCalls = 0;

	const result = await service.resolve({
		lastInterviewerTurn: baseQuery,
		preparedTranscript: baseQuery,
		assistantResponseCount: 0,
		startedAt: Date.now(),
		hardBudgetMs: 1_000,
		isLikelyGeneralIntent: false,
		classifyIntent: async () => {
			classifyCalls += 1;
			return { intent: "general", confidence: 0, answerShape: "" };
		},
		prefetchedIntent: {
			intent: "coding",
			confidence: 0.95,
			answerShape: "Provide a full implementation.",
			provider: "test-prefetch",
			retryCount: 0,
		},
	});

	assert.equal(
		classifyCalls,
		0,
		"strong prefetch must short-circuit live classification",
	);
	assert.equal(result.intentResult.intent, "coding");
	assert.equal(result.intentResult.confidence, 0.95);
});

test("NAT-L3: ConsciousIntentService.resolve uses medium-confidence non-general prefetch without re-classification", async () => {
	const service = new ConsciousIntentService();
	let classifyCalls = 0;

	const result = await service.resolve({
		lastInterviewerTurn: baseQuery,
		preparedTranscript: baseQuery,
		assistantResponseCount: 0,
		startedAt: Date.now(),
		hardBudgetMs: 1_000,
		isLikelyGeneralIntent: false,
		classifyIntent: async () => {
			classifyCalls += 1;
			return { intent: "general", confidence: 0, answerShape: "" };
		},
		prefetchedIntent: {
			intent: "behavioral",
			confidence: 0.6,
			answerShape: "Tell one grounded story.",
			provider: "test-prefetch",
			retryCount: 0,
		},
	});

	assert.equal(
		classifyCalls,
		0,
		"medium-confidence non-general prefetch must short-circuit live classification",
	);
	assert.equal(result.intentResult.intent, "behavioral");
	assert.equal(result.intentResult.confidence, 0.6);
	assert.equal(result.timedOut, false);
});
