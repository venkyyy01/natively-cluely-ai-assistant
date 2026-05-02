import assert from "node:assert";
import { describe, it } from "node:test";
import { parseConsciousModeResponse } from "../ConsciousMode";
import { ConsciousRefinementOrchestrator } from "../conscious/ConsciousRefinementOrchestrator";

describe("ConsciousRefinementOrchestrator", () => {
	const orchestrator = new ConsciousRefinementOrchestrator();

	it("builds a shorten prompt that preserves the previous answer", () => {
		const prompt = orchestrator.buildPrompt({
			intent: "shorten",
			previousAnswer:
				"I built a caching layer on top of the database to reduce p99 latency from 500ms to 50ms.",
			lastInterviewerQuestion: "How would you reduce latency?",
			userRefinementRequest: "make it shorter",
		});
		assert.ok(prompt.systemPrompt.includes("candidate"));
		assert.ok(prompt.userMessage.includes("REFINEMENT_INTENT: shorten"));
		assert.ok(prompt.userMessage.includes("I built a caching layer"));
		assert.ok(prompt.userMessage.includes("USER_REQUEST: make it shorter"));
	});

	it("builds an expand prompt with the original question", () => {
		const prompt = orchestrator.buildPrompt({
			intent: "expand",
			previousAnswer: "I'd use Redis.",
			lastInterviewerQuestion: "Which cache would you choose?",
			userRefinementRequest: "tell me more",
		});
		assert.ok(prompt.userMessage.includes("REFINEMENT_INTENT: expand"));
		assert.ok(prompt.userMessage.includes("Which cache would you choose?"));
	});

	it("truncates very long previous answers", () => {
		const veryLong = "a".repeat(10_000);
		const prompt = orchestrator.buildPrompt({
			intent: "shorten",
			previousAnswer: veryLong,
			userRefinementRequest: "shorter please",
		});
		// Truncated marker present, message length is bounded.
		assert.ok(prompt.userMessage.length < 10_000);
		assert.ok(prompt.userMessage.includes("…"));
	});

	it("falls back when no previous answer is captured", () => {
		const prompt = orchestrator.buildPrompt({
			intent: "shorten",
			previousAnswer: "",
			userRefinementRequest: "shorter",
		});
		assert.ok(prompt.userMessage.includes("no previous answer was captured"));
	});

	it("flattens a structured response into spoken text", () => {
		const structured = parseConsciousModeResponse(
			JSON.stringify({
				schemaVersion: "conscious_mode_v1",
				mode: "reasoning_first",
				openingReasoning: "So basically I would shard by user_id.",
				implementationPlan: [
					"Add a hash ring on top of Postgres.",
					"Migrate writes through a dual-write phase.",
				],
				tradeoffs: ["Hot keys can still create skew."],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
				behavioralAnswer: null,
			}),
		);
		const flat = orchestrator.flattenStructuredAnswer(structured);
		assert.ok(flat.includes("shard by user_id"));
		assert.ok(flat.includes("hash ring"));
		assert.ok(flat.includes("Hot keys"));
		assert.ok(!flat.includes("\n"));
	});

	it("flattens behavioural answers into spoken text", () => {
		const structured = parseConsciousModeResponse(
			JSON.stringify({
				schemaVersion: "conscious_mode_v1",
				mode: "reasoning_first",
				openingReasoning: "",
				implementationPlan: [],
				tradeoffs: [],
				edgeCases: [],
				scaleConsiderations: [],
				pushbackResponses: [],
				likelyFollowUps: [],
				codeTransition: "",
				behavioralAnswer: {
					question: "Tell me about leadership",
					headline: "Led migration off legacy queue",
					situation: "We had nightly outages.",
					task: "Replace the queue with minimal disruption.",
					action: "Designed a dual-read shadow rollout.",
					result: "Reduced incident rate by 80%.",
					whyThisAnswerWorks: ["Concrete metric"],
				},
			}),
		);
		const flat = orchestrator.flattenStructuredAnswer(structured);
		assert.ok(flat.includes("Led migration"));
		assert.ok(flat.includes("80%"));
	});

	it("isRefinementUseful rejects shortening already short answers", () => {
		assert.strictEqual(
			orchestrator.isRefinementUseful({
				intent: "shorten",
				previousAnswer: "Short answer.",
			}),
			false,
		);
		assert.strictEqual(
			orchestrator.isRefinementUseful({
				intent: "shorten",
				previousAnswer: "a".repeat(200),
			}),
			true,
		);
	});

	it("isRefinementUseful rejects expanding already long answers", () => {
		assert.strictEqual(
			orchestrator.isRefinementUseful({
				intent: "expand",
				previousAnswer: "a".repeat(2000),
			}),
			false,
		);
	});

	it("isRefinementUseful is false on empty previous answer", () => {
		assert.strictEqual(
			orchestrator.isRefinementUseful({
				intent: "rephrase",
				previousAnswer: "",
			}),
			false,
		);
	});
});
