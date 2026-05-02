import assert from "node:assert/strict";
import test from "node:test";
import { InterviewerUtteranceBuffer } from "../buffering/InterviewerUtteranceBuffer";
import {
	CONSCIOUS_MODE_SCHEMA_VERSION,
	classifyConsciousModeQuestion,
	maybeHandleSuggestionTriggerFromTranscript,
	parseConsciousModeResponse,
	type ReasoningThread,
	shouldAutoTriggerSuggestionFromTranscript,
	tryParseConsciousModeOpeningReasoning,
} from "../ConsciousMode";
import { IntelligenceEngine } from "../IntelligenceEngine";
import { CONSCIOUS_BEHAVIORAL_REASONING_SYSTEM_PROMPT } from "../llm/prompts";
import { SessionTracker } from "../SessionTracker";

type StreamCall = {
	message: string;
	context?: string;
	prompt?: string;
	options?: {
		skipKnowledgeInterception?: boolean;
		qualityTier?: "fast" | "quality" | "verify";
	};
};

// NAT-004: ConsciousProvenanceVerifier now fails closed when a structured
// response names a technology or quotes a metric and there is no semantic
// grounding context to verify it against. The fake LLMs in this file emit
// responses that legitimately reference Redis, IP, QA, PM, and metrics like
// 10x, so we must seed a profile with vocabulary that covers those terms.
// Without this, the verifier rejects the response and the orchestrator falls
// back to raw streamed JSON / no recorded thread, masking what these tests
// actually want to assert (routing + STAR formatting + thread continuation).
// The profile must surface vocabulary for every question these tests ask
// (rate limiter, monolith → microservices migration, behavioral conflict
// stories) AND every term the structured responses cite (Redis, IP, QA,
// PM, 10x). The fact store keys facts by question-token overlap, so each
// expected question token must appear somewhere in a fact's text or tags.
const ROUTING_TEST_PROFILE = {
	identity: {
		name: "Jane Doe",
		role: "Senior Backend Engineer",
		summary:
			"Built distributed systems and APIs. Designed rate limiters with Redis " +
			"and IP-based throttling. Migrated a monolith to microservices using " +
			"the strangler pattern. Partnered with QA on release validation and " +
			"with PM on incident communications. Scaled traffic 10x in prior roles.",
	},
	skills: [
		"Redis",
		"rate limiting",
		"monolith migration",
		"microservices",
		"incident response",
	],
	projects: [
		{
			name: "Multi-region rate limiter",
			description:
				"Per-user token bucket backed by Redis with IP fallbacks for shared NAT, " +
				"tuned for 10x traffic spikes.",
			technologies: ["Redis", "IP", "token bucket", "API"],
		},
		{
			name: "Monolith to microservices migration",
			description:
				"Carved a legacy monolith into microservices via the strangler pattern, " +
				"extracting bounded contexts behind a Redis-backed gateway.",
			technologies: ["Redis", "microservices", "monolith", "API"],
		},
	],
	experience: [
		{
			company: "Acme",
			role: "Senior Backend Engineer",
			bullets: [
				"Designed rate limiter for the public API using Redis and per-IP buckets.",
				"Led migration from monolith to microservices behind a strangler facade.",
				"Partnered with QA on release validation checklists.",
				"Coordinated with PM on customer-impacting incidents.",
				"Scaled write throughput 10x by sharding hot keys.",
			],
		},
	],
	activeJD: {
		title: "Staff Backend Engineer",
		company: "ExampleCorp",
		technologies: [
			"Redis",
			"IP",
			"rate limiting",
			"microservices",
			"monolith",
			"API",
		],
		requirements: [
			"Design rate limiters for high-traffic APIs",
			"Migrate monolith services to microservices safely",
			"Coordinate with QA and PM during incidents",
		],
		keywords: [
			"Redis",
			"IP",
			"QA",
			"PM",
			"10x",
			"monolith",
			"microservices",
			"API",
			"design",
			"migrate",
		],
	},
};

function buildKnowledgeOrchestratorStub() {
	return {
		getStatus: () => ({ hasResume: true, hasActiveJD: true, activeMode: true }),
		getProfileData: () => ROUTING_TEST_PROFILE,
	};
}

class FakeLLMHelper {
	public calls: StreamCall[] = [];

	getKnowledgeOrchestrator() {
		return buildKnowledgeOrchestratorStub();
	}

	async *streamChat(
		message: string,
		_imagePaths?: string[],
		context?: string,
		prompt?: string,
		options?: StreamCall["options"],
	): AsyncGenerator<string> {
		this.calls.push({ message, context, prompt, options });

		if (message.includes("ACTIVE_REASONING_THREAD")) {
			yield JSON.stringify({
				mode: "reasoning_first",
				openingReasoning:
					"I would keep the same partitioning strategy and stress where it bends.",
				implementationPlan: [
					"Keep the per-user token bucket",
					"Add clearer backpressure controls",
				],
				tradeoffs: ["Higher coordination cost across regions"],
				edgeCases: ["Clock skew between nodes"],
				scaleConsiderations: [
					"Shard counters and move hot keys behind consistent hashing",
				],
				pushbackResponses: [
					"I chose this because it keeps the hot path simple while leaving room to shard later.",
				],
				likelyFollowUps: ["What if one shard gets hot?"],
				codeTransition:
					"After that explanation, I would sketch the token bucket interface and storage abstraction.",
			});
			return;
		}

		if (message.includes("STRUCTURED_REASONING_RESPONSE")) {
			yield JSON.stringify({
				mode: "reasoning_first",
				openingReasoning:
					"I would start by clarifying the rate limit dimension and the consistency target.",
				implementationPlan: [
					"Start with a per-user token bucket",
					"Store counters in Redis",
					"Add a small burst allowance",
				],
				tradeoffs: ["Redis adds operational overhead"],
				edgeCases: ["Users sharing an IP can create false positives"],
				scaleConsiderations: [
					"Shard keys and batch writes when traffic spikes",
				],
				pushbackResponses: [
					"I would say I optimized for predictable enforcement before global scale.",
				],
				likelyFollowUps: ["What happens if traffic is 10x larger?"],
				codeTransition:
					"Once aligned on the approach, I would walk into the token refill logic.",
			});
			return;
		}

		yield "plain answer";
	}
}

function addInterviewerTurn(
	session: SessionTracker,
	text: string,
	timestamp: number,
): void {
	session.handleTranscript({
		speaker: "interviewer",
		text,
		timestamp,
		final: true,
	});
}

test("Conscious Mode routes qualifying technical questions into the structured reasoning contract", async () => {
	const session = new SessionTracker();
	const llmHelper = new FakeLLMHelper();
	const engine = new IntelligenceEngine(llmHelper as any, session);

	session.setConsciousModeEnabled(true);
	addInterviewerTurn(
		session,
		"How would you design a rate limiter for an API?",
		Date.now(),
	);

	const answer = await engine.runWhatShouldISay(undefined, 0.92);
	const structured = session.getLatestConsciousResponse();
	const thread = session.getActiveReasoningThread();

	assert.ok(answer);
	assert.ok(
		answer?.includes("I would start by clarifying the rate limit dimension"),
	);
	assert.equal(structured?.mode, "reasoning_first");
	assert.equal(
		structured?.openingReasoning,
		"I would start by clarifying the rate limit dimension and the consistency target.",
	);
	assert.deepEqual(structured?.implementationPlan, [
		"Start with a per-user token bucket",
		"Store counters in Redis",
		"Add a small burst allowance",
	]);
	assert.equal(
		thread?.rootQuestion,
		"How would you design a rate limiter for an API?",
	);
	assert.equal(thread?.followUpCount, 0);
	assert.match(
		llmHelper.calls[0]?.message || "",
		/STRUCTURED_REASONING_RESPONSE/,
	);
	assert.equal(llmHelper.calls[0]?.options?.skipKnowledgeInterception, true);
	assert.equal(llmHelper.calls[0]?.options?.qualityTier, "verify");
});

test("Conscious Mode formats behavioral answers into the strict STAR interview layout", async () => {
	class BehavioralLLMHelper {
		public calls: StreamCall[] = [];

		getKnowledgeOrchestrator() {
			return buildKnowledgeOrchestratorStub();
		}

		async *streamChat(
			message: string,
			_imagePaths?: string[],
			context?: string,
			prompt?: string,
			options?: StreamCall["options"],
		): AsyncGenerator<string> {
			this.calls.push({ message, context, prompt, options });

			yield JSON.stringify({
				mode: "reasoning_first",
				openingReasoning:
					"I helped unblock a production issue during a release by tightening the rollback path and aligning the team quickly.",
				behavioralAnswer: {
					question: "Handled team conflict during a production issue",
					headline:
						"I helped unblock a production issue during a release by tightening the rollback path and aligning the team quickly.",
					situation:
						"We were in the middle of a production release, and there was disagreement between backend and QA on whether to keep pushing or roll back after we saw unstable behavior.",
					task: "I needed to get the release back to a safe state, reduce confusion, and make sure we made a decision based on evidence instead of opinions.",
					action:
						"I pulled the recent logs and deployment diff, isolated the risky change set, and proposed a rollback of only that slice instead of reverting everything. I aligned with QA on a short validation checklist, kept the PM updated on what we were doing, and made sure the discussion stayed focused on user impact and recovery time. After the rollback, I documented the failure mode and added a release check so the same confusion would not repeat.",
					result:
						"We stabilized the release the same day, avoided a broader rollback, and the team had a much clearer runbook for similar issues after that.",
					whyThisAnswerWorks: [
						"Shows ownership under pressure",
						"Shows conflict resolution with evidence-based communication",
						"Ends with a concrete operational improvement",
					],
				},
			});
		}
	}

	const session = new SessionTracker();
	const llmHelper = new BehavioralLLMHelper();
	const engine = new IntelligenceEngine(llmHelper as any, session);

	session.setConsciousModeEnabled(true);
	addInterviewerTurn(
		session,
		"Tell me about a time you handled team conflict during a production issue.",
		Date.now(),
	);

	const answer = await engine.runWhatShouldISay(undefined, 0.91);

	assert.match(
		answer || "",
		/Question: Handled team conflict during a production issue/,
	);
	assert.match(answer || "", /Headline:/);
	assert.match(
		answer || "",
		/I helped unblock a production issue during a release by tightening the rollback path and aligning the team quickly/,
	);
	assert.match(answer || "", /Situation:/);
	assert.match(answer || "", /We were in the middle of a production release/);
	assert.match(
		answer || "",
		/Task: I needed to get the release back to a safe state/,
	);
	assert.match(answer || "", /Action:/);
	assert.match(answer || "", /I pulled the recent logs and deployment diff/);
	assert.match(answer || "", /Result:/);
	assert.match(answer || "", /We stabilized the release the same day/);
	assert.match(answer || "", /Why this answer works:/);
	assert.match(answer || "", /- Shows ownership under pressure/);
	assert.equal(
		llmHelper.calls[0]?.prompt,
		CONSCIOUS_BEHAVIORAL_REASONING_SYSTEM_PROMPT,
	);
});

test("Conscious Mode qualifying follow-ups continue the thread, while a new technical topic resets it", async () => {
	const session = new SessionTracker();
	const llmHelper = new FakeLLMHelper();
	const engine = new IntelligenceEngine(llmHelper as any, session);

	session.setConsciousModeEnabled(true);
	addInterviewerTurn(
		session,
		"How would you design a rate limiter for an API?",
		Date.now() - 2000,
	);
	await engine.runWhatShouldISay(undefined, 0.88);

	(engine as any).lastTriggerTime = 0;
	addInterviewerTurn(session, "What are the tradeoffs?", Date.now() - 1000);
	await engine.runWhatShouldISay(undefined, 0.88);

	const continuedThread = session.getActiveReasoningThread();
	assert.equal(
		continuedThread?.rootQuestion,
		"How would you design a rate limiter for an API?",
	);
	assert.equal(continuedThread?.followUpCount, 1);
	assert.match(llmHelper.calls[1]?.message || "", /ACTIVE_REASONING_THREAD/);

	(engine as any).lastTriggerTime = 0;
	addInterviewerTurn(
		session,
		"How would you migrate a monolith to microservices?",
		Date.now(),
	);
	await engine.runWhatShouldISay(undefined, 0.88);

	const resetThread = session.getActiveReasoningThread();
	assert.equal(
		resetThread?.rootQuestion,
		"How would you migrate a monolith to microservices?",
	);
	assert.equal(resetThread?.followUpCount, 0);
	assert.match(
		llmHelper.calls[2]?.message || "",
		/STRUCTURED_REASONING_RESPONSE/,
	);
});

test("Conscious Mode does not spuriously route casual or admin transcript lines", () => {
	assert.deepEqual(
		classifyConsciousModeQuestion("I sent the calendar invite already", null),
		{
			qualifies: false,
			threadAction: "ignore",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion("Redis cache warmup is done", null),
		{
			qualifies: false,
			threadAction: "ignore",
		},
	);

	assert.deepEqual(classifyConsciousModeQuestion("okay sounds good", null), {
		qualifies: false,
		threadAction: "ignore",
	});
});

test("Conscious Mode keeps continuation phrases on the normal path when no active thread exists", () => {
	assert.deepEqual(
		classifyConsciousModeQuestion("What are the tradeoffs?", null),
		{
			qualifies: true,
			threadAction: "start",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion("How would you shard this?", null),
		{
			qualifies: true,
			threadAction: "start",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion("What happens during failover?", null),
		{
			qualifies: false,
			threadAction: "ignore",
		},
	);
});

test("Conscious Mode only starts for system-design questions and prefers fresh starts for ambiguous new design prompts", () => {
	const thread = {
		rootQuestion: "How would you design a rate limiter for an API?",
		lastQuestion: "What are the tradeoffs?",
		followUpCount: 1,
		updatedAt: Date.now(),
		response: parseConsciousModeResponse(
			JSON.stringify({
				mode: "reasoning_first",
				openingReasoning: "Start with a token bucket.",
				implementationPlan: ["Use Redis"],
			}),
		),
	};

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"How would you design a notification system?",
			null,
		),
		{
			qualifies: true,
			threadAction: "start",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"Write the debounce function in TypeScript.",
			null,
		),
		{
			qualifies: false,
			threadAction: "ignore",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"Tell me about a time you handled team conflict.",
			null,
		),
		{
			qualifies: true,
			threadAction: "start",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion("How do you make difficult decisions?", null),
		{
			qualifies: true,
			threadAction: "start",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"How would you design the data model for billing?",
			thread,
		),
		{
			qualifies: true,
			threadAction: "reset",
		},
	);
});

test("Conscious Mode continuation and reset matrix handles deterministic continuation phrases and unrelated topics", () => {
	const thread = {
		rootQuestion: "How would you design a rate limiter for an API?",
		lastQuestion: "What are the tradeoffs?",
		followUpCount: 1,
		updatedAt: Date.now(),
		response: parseConsciousModeResponse(
			JSON.stringify({
				mode: "reasoning_first",
				openingReasoning: "Start with a token bucket.",
				implementationPlan: ["Use Redis"],
			}),
		),
	};

	assert.deepEqual(
		classifyConsciousModeQuestion("What are the tradeoffs?", thread),
		{
			qualifies: true,
			threadAction: "continue",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion("How would you shard this?", thread),
		{
			qualifies: true,
			threadAction: "continue",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion("What happens during failover?", thread),
		{
			qualifies: true,
			threadAction: "continue",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"What metrics would you watch first?",
			thread,
		),
		{
			qualifies: true,
			threadAction: "continue",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"What if traffic spikes 10x on this API?",
			thread,
		),
		{
			qualifies: true,
			threadAction: "continue",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion("How would you design a payment ledger?", {
			...thread,
			updatedAt: Date.now() - 120000,
		}),
		{
			qualifies: true,
			threadAction: "reset",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"How would you design a cache invalidation service?",
			thread,
		),
		{
			qualifies: true,
			threadAction: "reset",
		},
	);

	assert.deepEqual(classifyConsciousModeQuestion("What if?", thread), {
		qualifies: false,
		threadAction: "ignore",
	});

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"Let us switch gears and talk about the launch plan.",
			thread,
		),
		{
			qualifies: true,
			threadAction: "reset",
		},
	);

	assert.deepEqual(
		classifyConsciousModeQuestion(
			"That is interesting, but let us talk about security instead.",
			thread,
		),
		{
			qualifies: true,
			threadAction: "reset",
		},
	);
});

test("Conscious Mode response parser rejects malformed non-JSON thread payloads", () => {
	const malformed = parseConsciousModeResponse(
		"here is a nice answer but not json at all",
	);

	assert.equal(malformed.mode, "invalid");
	assert.equal(malformed.openingReasoning, "");
	assert.deepEqual(malformed.implementationPlan, []);
});

test("Conscious Mode parser adapts legacy prompt-family payloads to the canonical schema", () => {
	const parsed = parseConsciousModeResponse(
		JSON.stringify({
			openingReasoning: "I would start with the invariant first.",
			spokenResponse:
				"Keep writes idempotent and make duplicate delivery harmless.",
			codeBlock: { language: "ts", code: "const seen = new Set<string>();" },
			pushbackResponses: {
				consistency:
					"I would tighten the write path before adding async fan-out.",
			},
		}),
	);

	assert.equal(parsed.mode, "reasoning_first");
	assert.equal(
		parsed.openingReasoning,
		"I would start with the invariant first.",
	);
	assert.deepEqual(parsed.pushbackResponses, [
		"consistency: I would tighten the write path before adding async fan-out.",
	]);
	assert.match(parsed.codeTransition, /```ts/);
	assert.equal(CONSCIOUS_MODE_SCHEMA_VERSION, "conscious_mode_v1");
});

test("Conscious Mode can parse opening reasoning from a streaming JSON prefix", () => {
	const partial =
		'{"schemaVersion":"conscious_mode_v1","mode":"reasoning_first","openingReasoning":"Start with Redis and a clear refill invariant."';

	assert.equal(
		tryParseConsciousModeOpeningReasoning(partial),
		"Start with Redis and a clear refill invariant.",
	);
});

test("Conscious Mode transcript auto-trigger widens for actionable interviewer prompts without widening conscious routing itself", () => {
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript("Why this approach", false, null),
		false,
	);
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript("Why this approach", true, null),
		true,
	);
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript(
			"What are the tradeoffs",
			true,
			null,
		),
		true,
	);
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript(
			"Give me an example of when you disagreed with a PM",
			true,
			null,
		),
		true,
	);
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript(
			"How do you make difficult decisions",
			true,
			null,
		),
		true,
	);
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript("So designing a", true, null),
		false,
	);
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript(
			"Can you repeat that for me",
			true,
			null,
		),
		false,
	);
	assert.equal(
		shouldAutoTriggerSuggestionFromTranscript("okay sounds good", true, null),
		false,
	);
});

test("Conscious Mode transcript-trigger path fires for substantive interviewer prompts when awareness is enabled", async () => {
	const calls: Array<{
		context: string;
		lastQuestion: string;
		confidence: number;
	}> = [];
	const manager = {
		getActiveReasoningThread: (): ReasoningThread | null => null,
		getFormattedContext: (): string => "ctx",
		handleSuggestionTrigger: async (trigger: {
			context: string;
			lastQuestion: string;
			confidence: number;
		}) => {
			calls.push(trigger);
		},
	};

	const utteranceBuffer = new InterviewerUtteranceBuffer();

	await maybeHandleSuggestionTriggerFromTranscript({
		speaker: "interviewer",
		text: "Why this approach",
		final: true,
		confidence: 0.91,
		consciousModeEnabled: true,
		intelligenceManager: manager,
		utteranceBuffer,
	});

	utteranceBuffer.flush("punctuation");

	await maybeHandleSuggestionTriggerFromTranscript({
		speaker: "interviewer",
		text: "Can you repeat that for me",
		final: true,
		confidence: 0.72,
		consciousModeEnabled: true,
		intelligenceManager: manager,
		utteranceBuffer,
	});

	utteranceBuffer.flush("punctuation");

	assert.deepEqual(calls, [
		{
			context: "ctx",
			lastQuestion: "Why this approach",
			confidence: 0.91,
			sourceUtteranceId: "utterance-1",
		},
	]);

	utteranceBuffer.dispose();
});

test("Conscious Mode routes screenshot-backed live-coding turns but keeps the same question on the fast path without screenshots", async () => {
	class LiveCodingHelper {
		public calls: Array<{ message: string; prompt?: string }> = [];

		async *streamChat(
			message: string,
			_imagePaths?: string[],
			_context?: string,
			prompt?: string,
		): AsyncGenerator<string> {
			this.calls.push({ message, prompt });

			if (message.includes("STRUCTURED_REASONING_RESPONSE")) {
				yield JSON.stringify({
					mode: "reasoning_first",
					openingReasoning:
						"I would read the failing state from the screenshot first, then patch the debounce flow.",
					implementationPlan: [
						"Confirm stale closure path",
						"Patch the debounce state update",
					],
					tradeoffs: [],
					edgeCases: [],
					scaleConsiderations: [],
					pushbackResponses: [],
					likelyFollowUps: [],
					codeTransition: "",
				});
				return;
			}

			yield "Use a debounced callback and clear the previous timeout before scheduling a new one.";
		}
	}

	const question = "Write the debounce function in TypeScript.";

	const noScreenshotSession = new SessionTracker();
	const noScreenshotHelper = new LiveCodingHelper();
	const noScreenshotEngine = new IntelligenceEngine(
		noScreenshotHelper as any,
		noScreenshotSession,
	);
	noScreenshotSession.setConsciousModeEnabled(true);
	addInterviewerTurn(noScreenshotSession, question, Date.now() - 1000);

	const fastAnswer = await noScreenshotEngine.runWhatShouldISay(undefined, 0.9);
	assert.equal(
		fastAnswer,
		"Use a debounced callback and clear the previous timeout before scheduling a new one.",
	);
	assert.equal(noScreenshotSession.getLatestConsciousResponse(), null);
	assert.ok(
		noScreenshotHelper.calls.every(
			(call) => !call.message.includes("STRUCTURED_REASONING_RESPONSE"),
		),
	);

	const screenshotSession = new SessionTracker();
	const screenshotHelper = new LiveCodingHelper();
	const screenshotEngine = new IntelligenceEngine(
		screenshotHelper as any,
		screenshotSession,
	);
	screenshotSession.setConsciousModeEnabled(true);
	addInterviewerTurn(screenshotSession, question, Date.now());

	const consciousAnswer = await screenshotEngine.runWhatShouldISay(
		undefined,
		0.9,
		["/tmp/editor.png"],
	);
	assert.match(consciousAnswer || "", /read the failing state/);
	assert.equal(
		screenshotSession.getLatestConsciousResponse()?.mode,
		"reasoning_first",
	);
	assert.match(
		screenshotHelper.calls[0]?.message || "",
		/STRUCTURED_REASONING_RESPONSE/,
	);
});

test("Non-Conscious transcript-trigger path preserves the existing actionable heuristic", async () => {
	const calls: Array<{
		context: string;
		lastQuestion: string;
		confidence: number;
	}> = [];
	const manager = {
		getActiveReasoningThread: (): ReasoningThread | null => null,
		getFormattedContext: (): string => "ctx",
		handleSuggestionTrigger: async (trigger: {
			context: string;
			lastQuestion: string;
			confidence: number;
		}) => {
			calls.push(trigger);
		},
	};

	const utteranceBuffer = new InterviewerUtteranceBuffer();

	await maybeHandleSuggestionTriggerFromTranscript({
		speaker: "interviewer",
		text: "Can you repeat that for me",
		final: true,
		confidence: 0.72,
		consciousModeEnabled: false,
		intelligenceManager: manager,
		utteranceBuffer,
	});

	utteranceBuffer.flush("punctuation");

	await maybeHandleSuggestionTriggerFromTranscript({
		speaker: "interviewer",
		text: "okay sounds good",
		final: true,
		confidence: 0.72,
		consciousModeEnabled: false,
		intelligenceManager: manager,
		utteranceBuffer,
	});

	utteranceBuffer.flush("punctuation");

	assert.deepEqual(calls, [
		{
			context: "ctx",
			lastQuestion: "Can you repeat that for me",
			confidence: 0.72,
			sourceUtteranceId: "utterance-1",
		},
	]);

	utteranceBuffer.dispose();
});

test("Conscious Mode falls back to the normal intent path when structured output is malformed", async () => {
	class MalformedStructuredLLMHelper {
		public calls: string[] = [];

		async *streamChat(message: string): AsyncGenerator<string> {
			this.calls.push(message);

			if (message.includes("STRUCTURED_REASONING_RESPONSE")) {
				yield "not-json-at-all";
				return;
			}

			yield "Start with a token bucket and keep the explanation simple.";
		}
	}

	const session = new SessionTracker();
	const llmHelper = new MalformedStructuredLLMHelper();
	const engine = new IntelligenceEngine(llmHelper as any, session);

	session.setConsciousModeEnabled(true);
	addInterviewerTurn(
		session,
		"How would you design a rate limiter for an API?",
		Date.now(),
	);

	const answer = await engine.runWhatShouldISay(undefined, 0.9);

	assert.equal(
		answer,
		"Start with a token bucket and keep the explanation simple.",
	);
	assert.equal(session.getLatestConsciousResponse(), null);
	assert.equal(session.getActiveReasoningThread(), null);
	assert.equal(llmHelper.calls.length, 2);
});

test("Conscious Mode reset clears the old thread before malformed structured fallback on a new technical topic", async () => {
	class ResetFallbackLLMHelper {
		public calls: string[] = [];

		getKnowledgeOrchestrator() {
			return buildKnowledgeOrchestratorStub();
		}

		async *streamChat(message: string): AsyncGenerator<string> {
			this.calls.push(message);

			if (message.includes("STRUCTURED_REASONING_RESPONSE")) {
				if (message.includes("migrate a monolith to microservices")) {
					yield "not-json-at-all";
					return;
				}

				yield JSON.stringify({
					mode: "reasoning_first",
					openingReasoning:
						"I would start by clarifying the rate limit dimension and the consistency target.",
					implementationPlan: ["Start with a per-user token bucket"],
					tradeoffs: ["Redis adds operational overhead"],
					edgeCases: [],
					scaleConsiderations: [],
					pushbackResponses: [],
					likelyFollowUps: [],
					codeTransition: "",
				});
				return;
			}

			yield "Start with the strangler pattern and carve out one bounded context first.";
		}
	}

	const session = new SessionTracker();
	const llmHelper = new ResetFallbackLLMHelper();
	const engine = new IntelligenceEngine(llmHelper as any, session);

	session.setConsciousModeEnabled(true);
	addInterviewerTurn(
		session,
		"How would you design a rate limiter for an API?",
		Date.now() - 1000,
	);
	await engine.runWhatShouldISay(undefined, 0.9);

	const originalThread = session.getActiveReasoningThread();
	assert.equal(
		originalThread?.rootQuestion,
		"How would you design a rate limiter for an API?",
	);

	(engine as any).lastTriggerTime = 0;
	addInterviewerTurn(
		session,
		"How would you migrate a monolith to microservices?",
		Date.now(),
	);
	const answer = await engine.runWhatShouldISay(undefined, 0.9);

	assert.equal(
		answer,
		"Start with the strangler pattern and carve out one bounded context first.",
	);
	assert.equal(session.getActiveReasoningThread(), null);
	assert.equal(session.getLatestConsciousResponse(), null);
});
