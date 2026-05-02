import assert from "node:assert/strict";
import test from "node:test";
import type {
	ConsciousModeStructuredResponse,
	ReasoningThread,
} from "../ConsciousMode";
import { setOptimizationFlagsForTesting } from "../config/optimizations";
import type { AnswerHypothesis } from "../conscious/AnswerHypothesisStore";
import { ConsciousOrchestrator } from "../conscious/ConsciousOrchestrator";
import { ConsciousVerifier } from "../conscious/ConsciousVerifier";
import type { QuestionReaction } from "../conscious/QuestionReactionClassifier";
import type { IntentResult } from "../llm/IntentClassifier";

const response: ConsciousModeStructuredResponse = {
	mode: "reasoning_first",
	openingReasoning: "Use token buckets.",
	implementationPlan: ["Use Redis"],
	tradeoffs: [],
	edgeCases: [],
	scaleConsiderations: [],
	pushbackResponses: [],
	likelyFollowUps: [],
	codeTransition: "",
};

const reaction: QuestionReaction = {
	kind: "topic_shift",
	confidence: 0.95,
	cues: ["explicit_topic_shift"],
	targetFacets: [],
	shouldContinueThread: false,
};

function createThread(): ReasoningThread {
	return {
		rootQuestion: "How would you design a rate limiter?",
		lastQuestion: "How would you design a rate limiter?",
		response,
		followUpCount: 1,
		updatedAt: Date.now(),
	};
}

function createSession(overrides?: {
	latestReaction?: QuestionReaction | null;
	activeThread?: ReasoningThread | null;
}) {
	let cleared = false;
	const session = {
		isConsciousModeEnabled: (): boolean => true,
		getActiveReasoningThread: (): ReasoningThread | null => {
			if (overrides && Object.hasOwn(overrides, "activeThread")) {
				return overrides.activeThread ?? null;
			}

			return createThread();
		},
		getLatestConsciousResponse: (): ConsciousModeStructuredResponse | null =>
			null,
		clearConsciousModeThread: () => {
			cleared = true;
		},
		getFormattedContext: (): string => "",
		getConsciousEvidenceContext: (): string => "",
		getConsciousSemanticContext: (): string => "",
		getConsciousLongMemoryContext: (): string => "",
		getLatestQuestionReaction: (): QuestionReaction | null => {
			if (overrides && Object.hasOwn(overrides, "latestReaction")) {
				return overrides.latestReaction ?? null;
			}

			return reaction;
		},
		getLatestAnswerHypothesis: (): AnswerHypothesis | null => null,
		recordConsciousResponse: (): void => {},
	};

	return {
		session,
		wasCleared: () => cleared,
	};
}

test("ConsciousOrchestrator.prepareRoute is side-effect free for reset decisions", async () => {
	const { session, wasCleared } = createSession();

	const orchestrator = new ConsciousOrchestrator(session as any);
	const prepared = await orchestrator.prepareRoute({
		question: "Let us switch gears and talk about the launch plan.",
		knowledgeStatus: null,
		screenshotBackedLiveCodingTurn: false,
	});

	assert.equal(prepared.preRouteDecision.threadAction, "reset");
	assert.equal(wasCleared(), false);

	orchestrator.applyRouteSideEffects(prepared);
	assert.equal(wasCleared(), true);
});

test("ConsciousOrchestrator.prepareRoute resets when classifier continuation is topically incompatible", async () => {
	const { session } = createSession({
		latestReaction: {
			kind: "generic_follow_up",
			confidence: 0.7,
			cues: ["active_thread_follow_up"],
			targetFacets: [],
			shouldContinueThread: true,
		},
	});

	const orchestrator = new ConsciousOrchestrator(session as any);
	const prepared = await orchestrator.prepareRoute({
		question: "Can you explain payroll compliance controls?",
		knowledgeStatus: null,
		screenshotBackedLiveCodingTurn: false,
	});

	assert.equal(prepared.preRouteDecision.threadAction, "reset");
});

test("ConsciousOrchestrator.prepareRoute preserves referential continuation for short follow-ups", async () => {
	const { session } = createSession({ latestReaction: null });

	const orchestrator = new ConsciousOrchestrator(session as any);
	const prepared = await orchestrator.prepareRoute({
		question: "Would that still hold?",
		knowledgeStatus: null,
		screenshotBackedLiveCodingTurn: false,
	});

	assert.equal(prepared.preRouteDecision.threadAction, "continue");
});

test("ConsciousOrchestrator.prepareRoute can promote prefetched inferred intents into the conscious route", async () => {
	const { session } = createSession({
		latestReaction: null,
		activeThread: null,
	});
	const orchestrator = new ConsciousOrchestrator(session as any);
	const prefetchedIntent: IntentResult = {
		intent: "behavioral",
		confidence: 0.94,
		answerShape: "Tell one grounded story.",
	};

	const prepared = await orchestrator.prepareRoute({
		question:
			"I want to understand how you handled a difficult stakeholder on a launch.",
		knowledgeStatus: null,
		screenshotBackedLiveCodingTurn: false,
		prefetchedIntent,
	});

	assert.equal(prepared.preRouteDecision.qualifies, true);
	assert.equal(prepared.preRouteDecision.threadAction, "start");
	assert.equal(prepared.selectedRoute, "conscious_answer");
});

test("ConsciousOrchestrator.prepareRoute recovers from weak prefetched intent via SLM/embedding layers", async () => {
	const { session } = createSession({
		latestReaction: null,
		activeThread: null,
	});
	const orchestrator = new ConsciousOrchestrator(session as any);

	// Even with a weak general prefetched intent, the layered router (SLM + embedding)
	// correctly identifies this as a deep_dive system design question.
	const prepared = await orchestrator.prepareRoute({
		question: "How would you partition the write path across tenants?",
		knowledgeStatus: null,
		screenshotBackedLiveCodingTurn: false,
		prefetchedIntent: {
			intent: "general",
			confidence: 0.41,
			answerShape: "Respond naturally.",
		},
	});

	assert.equal(prepared.selectedRoute, "conscious_answer");
	assert.equal(prepared.effectiveRoute, "conscious_answer");
});

test("ConsciousOrchestrator.prepareRoute promotes strong deep-dive prefetched intent into the conscious route", async () => {
	const { session } = createSession({
		latestReaction: null,
		activeThread: null,
	});
	const orchestrator = new ConsciousOrchestrator(session as any);

	const prepared = await orchestrator.prepareRoute({
		question: "What tradeoffs matter most here?",
		knowledgeStatus: null,
		screenshotBackedLiveCodingTurn: false,
		prefetchedIntent: {
			intent: "deep_dive",
			confidence: 0.93,
			answerShape: "Explain the core tradeoffs.",
		},
	});

	assert.equal(prepared.preRouteDecision.qualifies, true);
	assert.equal(prepared.preRouteDecision.threadAction, "start");
	assert.equal(prepared.selectedRoute, "conscious_answer");
});

test("ConsciousOrchestrator opens a circuit breaker after repeated conscious verification failures", async () => {
	const { session } = createSession({
		latestReaction: null,
		activeThread: null,
	});
	const failingVerifier = new ConsciousOrchestrator(
		session as any,
		new ConsciousVerifier({
			judge: async (): Promise<{ ok: false; reason: string }> => ({
				ok: false,
				reason: "forced_reject",
			}),
		} as any),
	);

	// Circuit breaker threshold is now 6 (was 3) to be more resilient
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const result = await failingVerifier.executeReasoningFirst({
			route: { qualifies: true, threadAction: "start" },
			question: "How would you design a rate limiter?",
			preparedTranscript: "QUESTION_MODE: system_design",
			temporalContext: {
				recentTranscript: "How would you design a rate limiter?",
				previousResponses: [],
				roleContext: "responding_to_interviewer",
				toneSignals: [],
				hasRecentResponses: false,
			},
			intentResult: {
				intent: "deep_dive",
				confidence: 0.95,
				answerShape: "Explain the tradeoffs.",
			},
			whatToAnswerLLM: {
				generateReasoningFirst: async () => response,
			} as any,
			answerLLM: null,
		});

		assert.equal(result.kind, "fallback");
	}

	const prepared = await failingVerifier.prepareRoute({
		question: "What tradeoffs matter most here?",
		knowledgeStatus: null,
		screenshotBackedLiveCodingTurn: false,
		prefetchedIntent: {
			intent: "deep_dive",
			confidence: 0.95,
			answerShape: "Explain the tradeoffs.",
		},
	});

	assert.notEqual(prepared.selectedRoute, "conscious_answer");
	assert.notEqual(prepared.effectiveRoute, "conscious_answer");
});

test("CM-002: degraded mode flag is respected by isVerifierOptimizationActive", () => {
	setOptimizationFlagsForTesting({ useDegradedProvenanceCheck: true });
	const { isVerifierOptimizationActive } = require("../config/optimizations");
	assert.equal(
		isVerifierOptimizationActive("useDegradedProvenanceCheck"),
		true,
	);

	setOptimizationFlagsForTesting({ useDegradedProvenanceCheck: false });
	assert.equal(
		isVerifierOptimizationActive("useDegradedProvenanceCheck"),
		false,
	);
});
