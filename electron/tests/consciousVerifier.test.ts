import assert from "node:assert/strict";
import test from "node:test";
import type { ConsciousModeStructuredResponse } from "../ConsciousMode";
import { setOptimizationFlagsForTesting } from "../config/optimizations";
import { ConsciousVerifier } from "../conscious/ConsciousVerifier";
import { ConsciousVerifierLLM } from "../conscious/ConsciousVerifierLLM";

function response(
	overrides: Partial<ConsciousModeStructuredResponse> = {},
): ConsciousModeStructuredResponse {
	return {
		mode: "reasoning_first",
		openingReasoning: "I would start with tenant partitioning.",
		implementationPlan: ["Partition by tenant"],
		tradeoffs: [],
		edgeCases: [],
		scaleConsiderations: [],
		pushbackResponses: [],
		likelyFollowUps: [],
		codeTransition: "",
		...overrides,
	};
}

test("ConsciousVerifier rejects tradeoff probes with no tradeoff or defense content", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response(),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "tradeoff_probe",
			confidence: 0.9,
			cues: ["tradeoff_language"],
			targetFacets: ["tradeoffs"],
			shouldContinueThread: true,
		},
		hypothesis: null,
		question: "What are the tradeoffs?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "missing_tradeoff_content");
});

test("ConsciousVerifier rejects duplicate continuation answers", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response({
			openingReasoning: "same answer",
			implementationPlan: [],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "generic_follow_up",
			confidence: 0.6,
			cues: ["active_thread_follow_up"],
			targetFacets: [],
			shouldContinueThread: true,
		},
		hypothesis: {
			sourceQuestion: "Why this approach?",
			latestSuggestedAnswer: "same answer",
			likelyThemes: ["same answer"],
			confidence: 0.8,
			evidence: ["suggested"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		question: "Why this approach?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "duplicate_follow_up_response");
});

test("ConsciousVerifier rejects behavioral questions without explicit STAR structure", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I handled a conflict by talking to the team and fixing the release issue.",
			implementationPlan: [],
		}),
		route: { qualifies: true, threadAction: "start" },
		reaction: null,
		hypothesis: null,
		question:
			"Tell me about a time you handled team conflict during a release.",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "missing_behavioral_star_structure");
});

test("ConsciousVerifier rejects behavioral answers when action depth and impact are too weak", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response({
			behavioralAnswer: {
				question: "How do you make difficult decisions?",
				headline: "I try to stay calm and make a decision.",
				situation: "There was a hard decision.",
				task: "I had to decide quickly.",
				action: "I discussed it with the team.",
				result: "It worked out.",
				whyThisAnswerWorks: [
					"Shows calmness",
					"Shows teamwork",
					"Shows decision-making",
				],
			},
		}),
		route: { qualifies: true, threadAction: "start" },
		reaction: null,
		hypothesis: null,
		question: "How do you make difficult decisions?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "weak_behavioral_depth");
});

test("ConsciousVerifier accepts concise behavioral answers when the action is still materially deeper than setup", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response({
			behavioralAnswer: {
				question: "Tell me about a time you handled disagreement on a launch.",
				headline: "I aligned two teams around a safer rollout plan.",
				situation:
					"A partner team wanted to skip rollback drills before a risky billing migration.",
				task: "I had to protect the launch without escalating the disagreement.",
				action:
					"I pulled prior incident data, proposed a phased rollout, and secured both managers on rollback checkpoints.",
				result:
					"We launched a week later, avoided incidents, and cut rollback pages by 40 percent.",
				whyThisAnswerWorks: [
					"Shows direct conflict resolution.",
					"Uses evidence instead of opinion.",
					"Ends with a concrete measurable result.",
				],
			},
		}),
		route: { qualifies: true, threadAction: "start" },
		reaction: null,
		hypothesis: null,
		question: "Tell me about a time you handled disagreement on a launch.",
	});

	assert.equal(result.ok, true);
});

test("ConsciousVerifier accepts a tradeoff probe when tradeoffs are present", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response({
			tradeoffs: ["Cross-tenant reads get more expensive"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "tradeoff_probe",
			confidence: 0.9,
			cues: ["tradeoff_language"],
			targetFacets: ["tradeoffs"],
			shouldContinueThread: true,
		},
		hypothesis: null,
		question: "What are the tradeoffs?",
	});

	assert.equal(result.ok, true);
});

test("ConsciousVerifier rejects unsupported numeric claims when evidence is inferred-dominant", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I would reduce p99 latency from 240ms to 90ms with a cache layer.",
			implementationPlan: [
				"Introduce read-through cache in front of the database",
			],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "metric_probe",
			confidence: 0.85,
			cues: ["metric_language"],
			targetFacets: ["scale"],
			shouldContinueThread: true,
		},
		hypothesis: {
			sourceQuestion: "How would you tune this endpoint?",
			latestSuggestedAnswer:
				"I would baseline the endpoint and remove N+1 queries first.",
			likelyThemes: ["latency baseline", "query optimization"],
			confidence: 0.78,
			evidence: ["inferred"],
			targetFacets: ["scale"],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "How would you tune this endpoint?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "unsupported_numeric_claim_in_inferred_state");
});

test("ConsciousVerifier accepts numeric claims grounded in prior evidence even when inferred-dominant", async () => {
	const verifier = new ConsciousVerifier();
	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I would hold the 70ms p99 baseline while reducing retries.",
			implementationPlan: [
				"Keep the existing 70ms budget and optimize retry backoff",
			],
			scaleConsiderations: [
				"Track p99 latency to keep the 70ms target stable.",
			],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "metric_probe",
			confidence: 0.85,
			cues: ["metric_language"],
			targetFacets: ["scale"],
			shouldContinueThread: true,
		},
		hypothesis: {
			sourceQuestion: "How would you keep latency stable?",
			latestSuggestedAnswer: "Current baseline is 70ms p99 latency under load.",
			likelyThemes: ["70ms baseline", "retry policy"],
			confidence: 0.82,
			evidence: ["inferred"],
			targetFacets: ["scale"],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "How would you keep latency stable?",
	});

	assert.equal(result.ok, true);
});

test("ConsciousVerifier falls back to rule-based acceptance when LLM judge is unavailable", async () => {
	const verifier = new ConsciousVerifier(
		new ConsciousVerifierLLM({
			generateContentStructured: async () =>
				'{"ok": false, "reason": "should_not_run"}',
			hasStructuredGenerationCapability: () => false,
		}),
	);

	const result = await verifier.verify({
		response: response({
			tradeoffs: ["Cross-tenant reads get more expensive"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "tradeoff_probe",
			confidence: 0.9,
			cues: ["tradeoff_language"],
			targetFacets: ["tradeoffs"],
			shouldContinueThread: true,
		},
		hypothesis: null,
		question: "What are the tradeoffs?",
	});

	assert.equal(result.ok, true);
});

test("ConsciousVerifier rejects in strict mode when the LLM judge is unavailable", async () => {
	const verifier = new ConsciousVerifier(
		new ConsciousVerifierLLM({
			generateContentStructured: async () =>
				'{"ok": false, "reason": "should_not_run"}',
			hasStructuredGenerationCapability: () => false,
		}),
		{ requireJudge: true },
	);

	const result = await verifier.verify({
		response: response({
			tradeoffs: ["Cross-tenant reads get more expensive"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "tradeoff_probe",
			confidence: 0.9,
			cues: ["tradeoff_language"],
			targetFacets: ["tradeoffs"],
			shouldContinueThread: true,
		},
		hypothesis: null,
		question: "What are the tradeoffs?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "judge_unavailable");
});

test("ConsciousVerifier honors an LLM judge rejection when rules pass", async () => {
	const verifier = new ConsciousVerifier(
		new ConsciousVerifierLLM(
			{
				generateContentStructured: async () =>
					'{"ok": false, "reason": "llm_detected_misalignment", "confidence": 0.91}',
				hasStructuredGenerationCapability: () => true,
			},
			50,
		),
	);

	const result = await verifier.verify({
		response: response({
			tradeoffs: ["Cross-tenant reads get more expensive"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: {
			kind: "tradeoff_probe",
			confidence: 0.9,
			cues: ["tradeoff_language"],
			targetFacets: ["tradeoffs"],
			shouldContinueThread: true,
		},
		hypothesis: null,
		question: "What are the tradeoffs?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "llm_detected_misalignment");
});

test('CM-001: rejects "java" claim when grounding only mentions "javascript" with word-boundary flag ON', async () => {
	setOptimizationFlagsForTesting({ useConsciousVerifierWordBoundary: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I would implement this in java using a reactive framework.",
			implementationPlan: ["Set up a java project with spring boot"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "What tech stack would you use?",
			latestSuggestedAnswer:
				"We should use javascript with node.js for the backend.",
			likelyThemes: ["javascript", "node.js", "backend"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "What tech stack would you use?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "unsupported_technology_claim_in_inferred_state");
});

test('CM-001: accepts "java" claim when grounding mentions java with word-boundary flag ON', async () => {
	setOptimizationFlagsForTesting({ useConsciousVerifierWordBoundary: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I would implement this in java using a reactive framework.",
			implementationPlan: ["Set up a java project with spring boot"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "What tech stack would you use?",
			latestSuggestedAnswer:
				"We should use java with spring boot for the backend.",
			likelyThemes: ["java", "spring boot", "backend"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "What tech stack would you use?",
	});

	assert.equal(result.ok, true);
});

test('CM-001: rejects "200ms" claim when grounding only mentions "20000" with word-boundary flag ON', async () => {
	setOptimizationFlagsForTesting({ useConsciousVerifierWordBoundary: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning: "I would reduce latency to 200ms by adding caching.",
			implementationPlan: ["Add redis cache layer"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "How would you improve performance?",
			latestSuggestedAnswer:
				"The system currently handles 20000 requests per second.",
			likelyThemes: ["throughput", "requests per second"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "How would you improve performance?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "unsupported_numeric_claim_in_inferred_state");
});

test('CM-001: accepts "70ms" claim grounded in "70ms p99 latency" with word-boundary flag ON', async () => {
	setOptimizationFlagsForTesting({ useConsciousVerifierWordBoundary: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I would maintain the 70ms p99 baseline while adding features.",
			implementationPlan: ["Keep existing cache layer"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "How would you keep latency stable?",
			latestSuggestedAnswer: "Current baseline is 70ms p99 latency under load.",
			likelyThemes: ["70ms baseline", "latency"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "How would you keep latency stable?",
	});

	assert.equal(result.ok, true);
});

test("CM-001: word-boundary flag OFF falls back to substring matching", async () => {
	setOptimizationFlagsForTesting({ useConsciousVerifierWordBoundary: false });
	const verifier = new ConsciousVerifier();

	// With substring matching (flag OFF), "java" should match "javascript" and pass
	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I would implement this in java using a reactive framework.",
			implementationPlan: ["Set up a java project with spring boot"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "What tech stack would you use?",
			latestSuggestedAnswer:
				"We should use javascript with node.js for the backend.",
			likelyThemes: ["javascript", "node.js", "backend"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "What tech stack would you use?",
	});

	assert.equal(result.ok, true);
});

test('CM-003: accepts year mention "2024" when not in grounding with tighter regex flag ON', async () => {
	setOptimizationFlagsForTesting({ useTighterNumericClaimRegex: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning: "In 2024 we shipped 3 features to improve the system.",
			implementationPlan: [],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "What did you accomplish?",
			latestSuggestedAnswer: "We improved the system architecture.",
			likelyThemes: ["architecture", "improvement"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "What did you accomplish?",
	});

	assert.equal(result.ok, true);
});

test('CM-003: accepts count "3 features" with tighter regex flag ON', async () => {
	setOptimizationFlagsForTesting({ useTighterNumericClaimRegex: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning: "We implemented 3 features to improve performance.",
			implementationPlan: [],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "How did you improve performance?",
			latestSuggestedAnswer: "We added caching and optimized queries.",
			likelyThemes: ["caching", "optimization"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "How did you improve performance?",
	});

	assert.equal(result.ok, true);
});

test('CM-003: rejects unsupported "200ms" with tighter regex flag ON', async () => {
	setOptimizationFlagsForTesting({ useTighterNumericClaimRegex: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning: "I would reduce latency to 200ms by adding caching.",
			implementationPlan: ["Add redis cache layer"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "How would you improve performance?",
			latestSuggestedAnswer:
				"The system currently handles 20000 requests per second.",
			likelyThemes: ["throughput", "requests per second"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "How would you improve performance?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "unsupported_numeric_claim_in_inferred_state");
});

test('CM-003: accepts grounded "200ms" with tighter regex flag ON', async () => {
	setOptimizationFlagsForTesting({ useTighterNumericClaimRegex: true });
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning:
				"I would maintain the 200ms p99 baseline while adding features.",
			implementationPlan: ["Keep existing cache layer"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "How would you keep latency stable?",
			latestSuggestedAnswer:
				"Current baseline is 200ms p99 latency under load.",
			likelyThemes: ["200ms baseline", "latency"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "How would you keep latency stable?",
	});

	assert.equal(result.ok, true);
});

test('CM-004: expanded allowlist catches "cassandra" when not in grounding with flag ON', async () => {
	setOptimizationFlagsForTesting({
		useExpandedTechAllowlist: true,
		useConsciousVerifierWordBoundary: true,
	});
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning: "I would use cassandra for the write path.",
			implementationPlan: ["Set up cassandra cluster"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "What database would you use?",
			latestSuggestedAnswer: "We should use postgres for the backend.",
			likelyThemes: ["postgres", "backend"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "What database would you use?",
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "unsupported_technology_claim_in_inferred_state");
});

test('CM-004: expanded allowlist accepts grounded "cassandra" with flag ON', async () => {
	setOptimizationFlagsForTesting({
		useExpandedTechAllowlist: true,
		useConsciousVerifierWordBoundary: true,
	});
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning: "I would use cassandra for the write path.",
			implementationPlan: ["Set up cassandra cluster"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "What database would you use?",
			latestSuggestedAnswer: "We should use cassandra for the write path.",
			likelyThemes: ["cassandra", "write path"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "What database would you use?",
	});

	assert.equal(result.ok, true);
});

test('CM-004: default allowlist misses "cassandra" with flag OFF', async () => {
	setOptimizationFlagsForTesting({
		useExpandedTechAllowlist: false,
		useConsciousVerifierWordBoundary: true,
	});
	const verifier = new ConsciousVerifier();

	const result = await verifier.verify({
		response: response({
			openingReasoning: "I would use cassandra for the write path.",
			implementationPlan: ["Set up cassandra cluster"],
		}),
		route: { qualifies: true, threadAction: "continue" },
		reaction: null,
		hypothesis: {
			sourceQuestion: "What database would you use?",
			latestSuggestedAnswer: "We should use postgres for the backend.",
			likelyThemes: ["postgres", "backend"],
			confidence: 0.8,
			evidence: ["inferred"],
			targetFacets: [],
			updatedAt: Date.now(),
		},
		evidence: ["inferred"],
		question: "What database would you use?",
	});

	assert.equal(result.ok, true);
});
