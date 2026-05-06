import assert from "node:assert/strict";
import test from "node:test";
import { ConsciousRetrievalOrchestrator } from "../conscious/ConsciousRetrievalOrchestrator";

test("ConsciousRetrievalOrchestrator builds a structured state block from thread and evidence", () => {
	const orchestrator = new ConsciousRetrievalOrchestrator({
		getFormattedContext: () => "[INTERVIEWER]: What are the tradeoffs?",
		getConsciousEvidenceContext: () =>
			"<conscious_evidence>demo</conscious_evidence>",
		getConsciousLongMemoryContext: () =>
			"<conscious_long_memory>Earlier shard discussion</conscious_long_memory>",
		getActiveReasoningThread: () => ({
			rootQuestion: "How would you partition a multi-tenant analytics system?",
			lastQuestion: "Why this approach?",
			response: {
				mode: "reasoning_first",
				openingReasoning: "I would partition by tenant.",
				implementationPlan: ["Partition by tenant"],
				tradeoffs: ["Cross-tenant reads get more expensive"],
				edgeCases: [],
				scaleConsiderations: ["Promote hot tenants to dedicated partitions"],
				pushbackResponses: ["The model keeps writes isolated."],
				likelyFollowUps: [],
				codeTransition: "",
			},
			followUpCount: 2,
			updatedAt: Date.now(),
		}),
		getLatestConsciousResponse: () => ({
			mode: "reasoning_first",
			openingReasoning: "I would partition by tenant.",
			implementationPlan: ["Partition by tenant"],
			tradeoffs: ["Cross-tenant reads get more expensive"],
			edgeCases: [],
			scaleConsiderations: ["Promote hot tenants to dedicated partitions"],
			pushbackResponses: ["The model keeps writes isolated."],
			likelyFollowUps: [],
			codeTransition: "",
		}),
		getLatestQuestionReaction: () => ({
			kind: "tradeoff_probe",
			confidence: 0.9,
			cues: ["tradeoff_language"],
			targetFacets: ["tradeoffs"],
			shouldContinueThread: true,
		}),
		getLatestAnswerHypothesis: () => ({
			sourceQuestion: "What are the tradeoffs?",
			latestSuggestedAnswer: "I would partition by tenant.",
			likelyThemes: [
				"Partition by tenant",
				"Cross-tenant reads get more expensive",
			],
			confidence: 0.84,
			evidence: ["suggested", "inferred"],
			reactionKind: "tradeoff_probe",
			targetFacets: ["tradeoffs"],
			updatedAt: Date.now(),
		}),
	});

	const pack = orchestrator.buildPack({ question: "What are the tradeoffs?" });

	assert.ok(pack.stateBlock.includes("<conscious_state>"));
	assert.ok(
		pack.stateBlock.includes("LATEST_INTERVIEWER_REACTION: tradeoff_probe"),
	);
	assert.ok(
		pack.stateBlock.includes(
			"LIKELY_USER_ANSWER_SUMMARY: I would partition by tenant.",
		),
	);
	assert.ok(
		pack.combinedContext.includes(
			"<conscious_long_memory>Earlier shard discussion</conscious_long_memory>",
		),
	);
	assert.ok(
		pack.combinedContext.includes(
			"<conscious_evidence>demo</conscious_evidence>",
		),
	);
	assert.ok(
		pack.combinedContext.includes("[INTERVIEWER]: What are the tradeoffs?"),
	);
});

test("ConsciousRetrievalOrchestrator builds live RAG block from high-signal recent context", () => {
	const orchestrator = new ConsciousRetrievalOrchestrator({
		getFormattedContext: () => "",
		getConsciousEvidenceContext: () => "",
		getConsciousLongMemoryContext: () => "",
		getActiveReasoningThread: () => null,
		getLatestConsciousResponse: () => null,
		getLatestQuestionReaction: () => null,
		getLatestAnswerHypothesis: () => null,
	});

	const now = Date.now();
	const block = orchestrator.buildLiveRagBlock({
		question: "How do you handle tenant hotspots and failover in this design?",
		contextItems: [
			{
				role: "interviewer",
				text: "How would you shard hot tenants?",
				timestamp: now - 5_000,
			},
			{
				role: "user",
				text: "I would isolate hot tenants to dedicated partitions and rebalance asynchronously.",
				timestamp: now - 4_000,
			},
			{
				role: "assistant",
				text: "Earlier fallback answer.",
				timestamp: now - 120_000,
			},
			{
				role: "interviewer",
				text: "What failure modes should we watch first?",
				timestamp: now - 3_000,
			},
		],
	});

	assert.ok(block.includes("<conscious_live_rag>"));
	assert.ok(block.includes("[INTERVIEWER] How would you shard hot tenants?"));
	assert.ok(
		block.includes(
			"[USER] I would isolate hot tenants to dedicated partitions and rebalance asynchronously.",
		),
	);
	assert.ok(
		block.includes("[INTERVIEWER] What failure modes should we watch first?"),
	);
	assert.ok(block.includes("</conscious_live_rag>"));
});

test("ConsciousRetrievalOrchestrator buildPack injects sanitized live RAG and skips fallback-like assistant items", () => {
	const now = Date.now();
	const orchestrator = new ConsciousRetrievalOrchestrator({
		getFormattedContext: () => "[INTERVIEWER]: Walk me through failover.",
		getContext: () => [
			{
				role: "interviewer",
				text: "How do you handle <failover> events?",
				timestamp: now - 4_000,
			},
			{
				role: "assistant",
				text: "Could you repeat that? I want to make sure I address your question properly.",
				timestamp: now - 3_000,
			},
			{
				role: "user",
				text: "I would use multi-region replication and a controlled leader failover runbook.",
				timestamp: now - 2_000,
			},
		],
		getConsciousEvidenceContext: () =>
			"<conscious_evidence>demo</conscious_evidence>",
		getConsciousLongMemoryContext: () =>
			"<conscious_long_memory>memory</conscious_long_memory>",
		getActiveReasoningThread: () => null,
		getLatestConsciousResponse: () => null,
		getLatestQuestionReaction: () => null,
		getLatestAnswerHypothesis: () => null,
	});

	const pack = orchestrator.buildPack({
		question: "How do you handle failover events?",
		lastSeconds: 300,
	});

	assert.ok(pack.combinedContext.includes("<conscious_live_rag>"));
	assert.ok(
		pack.combinedContext.includes(
			"[INTERVIEWER] How do you handle (failover) events?",
		),
	);
	assert.ok(
		pack.combinedContext.includes(
			"[USER] I would use multi-region replication and a controlled leader failover runbook.",
		),
	);
	assert.ok(!pack.combinedContext.includes("Could you repeat that?"));
});

test("ConsciousRetrievalOrchestrator buildPack skips guardrail refusal assistant items", () => {
	const now = Date.now();
	const orchestrator = new ConsciousRetrievalOrchestrator({
		getFormattedContext: () => "",
		getContext: () => [
			{
				role: "interviewer",
				text: "Can you explain your caching approach?",
				timestamp: now - 2_000,
			},
			{
				role: "assistant",
				text: "I can't share that information.",
				timestamp: now - 1_500,
			},
			{
				role: "user",
				text: "I would use Redis with short TTL and proactive invalidation.",
				timestamp: now - 1_000,
			},
		],
		getConsciousEvidenceContext: () => "",
		getConsciousLongMemoryContext: () => "",
		getActiveReasoningThread: () => null,
		getLatestConsciousResponse: () => null,
		getLatestQuestionReaction: () => null,
		getLatestAnswerHypothesis: () => null,
	});

	const pack = orchestrator.buildPack({
		question: "How would you design cache invalidation?",
	});

	assert.ok(pack.combinedContext.includes("<conscious_live_rag>"));
	assert.ok(!pack.combinedContext.includes("I can't share that information."));
	assert.ok(
		pack.combinedContext.includes(
			"[USER] I would use Redis with short TTL and proactive invalidation.",
		),
	);
});

test("ConsciousRetrievalOrchestrator buildPack deduplicates live RAG segments already grounded elsewhere", () => {
	const now = Date.now();
	const repeated = "Use Redis for counters";
	const orchestrator = new ConsciousRetrievalOrchestrator({
		getFormattedContext: () => "",
		getContext: () => [
			{
				role: "user",
				text: repeated,
				timestamp: now - 1000,
			},
		],
		getConsciousEvidenceContext: () =>
			`<conscious_evidence>\nLATEST_SUGGESTED_ANSWER: ${repeated}\n</conscious_evidence>`,
		getConsciousLongMemoryContext: () => "",
		getActiveReasoningThread: () => null,
		getLatestConsciousResponse: () => null,
		getLatestQuestionReaction: () => null,
		getLatestAnswerHypothesis: () => null,
	});

	const pack = orchestrator.buildPack({
		question: "How would you rate limit writes?",
	});
	const occurrences =
		pack.combinedContext.match(/Use Redis for counters/g) || [];

	assert.equal(occurrences.length, 1);
	assert.ok(!pack.combinedContext.includes("<conscious_live_rag>"));
});
