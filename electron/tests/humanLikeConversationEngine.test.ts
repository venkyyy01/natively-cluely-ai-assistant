import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type ConversationKind,
	HumanLikeConversationEngine,
} from "../conscious/HumanLikeConversationEngine";

describe("HumanLikeConversationEngine", () => {
	const engine = new HumanLikeConversationEngine();

	function expectKind(utterance: string, kind: ConversationKind): void {
		const result = engine.classify(utterance);
		assert.strictEqual(
			result.kind,
			kind,
			`Expected "${utterance}" to classify as ${kind} but got ${result.kind} (reason: ${result.reason})`,
		);
	}

	it("classifies plain greetings as smalltalk", () => {
		expectKind("Hi", "smalltalk");
		expectKind("Hello", "smalltalk");
		expectKind("Good morning", "smalltalk");
		expectKind("Thanks!", "smalltalk");
		expectKind("How are you?", "smalltalk");
	});

	it("classifies acknowledgements separately from smalltalk", () => {
		expectKind("Got it", "acknowledgement");
		expectKind("Makes sense", "acknowledgement");
		expectKind("Yeah", "acknowledgement");
		expectKind("Interesting", "acknowledgement");
	});

	it("classifies clarification requests", () => {
		expectKind("What do you mean?", "clarification");
		expectKind("Can you clarify that?", "clarification");
		expectKind("Sorry, can you repeat?", "clarification");
		expectKind("I don't understand", "clarification");
		expectKind("Wait, what?", "clarification");
	});

	it("classifies refinement requests with the right intent", () => {
		const shorter = engine.classify("Can you make it shorter?");
		assert.strictEqual(shorter.kind, "refinement");
		assert.strictEqual(shorter.refinementIntent, "shorten");

		const longer = engine.classify("Expand on that please");
		assert.strictEqual(longer.kind, "refinement");
		assert.strictEqual(longer.refinementIntent, "expand");

		const rephrase = engine.classify("Rephrase that");
		assert.strictEqual(rephrase.kind, "refinement");
		assert.strictEqual(rephrase.refinementIntent, "rephrase");

		const formal = engine.classify("Make it more professional");
		assert.strictEqual(formal.kind, "refinement");
		assert.strictEqual(formal.refinementIntent, "more_formal");

		const example = engine.classify("Give me an example");
		assert.strictEqual(example.kind, "refinement");
		assert.strictEqual(example.refinementIntent, "add_example");
	});

	it("classifies off-topic asides separately", () => {
		expectKind("By the way, do you use Postgres?", "off_topic_aside");
		expectKind("Actually, let me reconsider", "off_topic_aside");
	});

	it("falls through to technical for real questions", () => {
		expectKind("How would you design a rate limiter?", "technical");
		expectKind("Explain how Kafka handles backpressure", "technical");
	});

	it("classifies behavioral questions separately from technical", () => {
		expectKind("Tell me about a time you led a team", "behavioral");
		expectKind(
			"describe a situation where you had to handle a mistake",
			"behavioral",
		);
		expectKind(
			"walk me through your approach to optimizing a pipeline",
			"behavioral",
		);
	});

	it("recommends skip verification for smalltalk and acknowledgements", () => {
		const greet = engine.classify("Hello");
		assert.strictEqual(greet.verificationLevel, "skip");
		const ack = engine.classify("Got it");
		assert.strictEqual(ack.verificationLevel, "skip");
	});

	it("recommends relaxed verification for clarification and refinement", () => {
		const clar = engine.classify("What do you mean?");
		assert.strictEqual(clar.verificationLevel, "relaxed");
		const ref = engine.classify("Make it shorter");
		assert.strictEqual(ref.verificationLevel, "relaxed");
	});

	it("recommends strict verification for technical turns", () => {
		const tech = engine.classify("How would you shard the database?");
		assert.strictEqual(tech.verificationLevel, "strict");
	});

	it("shouldBypassStructuredSchema is true only for non-technical turns", () => {
		assert.strictEqual(engine.shouldBypassStructuredSchema("Hi"), true);
		assert.strictEqual(
			engine.shouldBypassStructuredSchema("Make it shorter"),
			true,
		);
		assert.strictEqual(
			engine.shouldBypassStructuredSchema(
				"Explain consistent hashing in detail",
			),
			false,
		);
	});

	it("handles empty utterances gracefully", () => {
		const result = engine.classify("");
		assert.strictEqual(result.kind, "smalltalk");
		assert.strictEqual(result.verificationLevel, "skip");
		assert.ok(result.confidence < 0.5);
	});

	it("preferFreeForm is true for non-technical turns", () => {
		assert.strictEqual(engine.classify("Hi").preferFreeForm, true);
		assert.strictEqual(engine.classify("Make it shorter").preferFreeForm, true);
		assert.strictEqual(
			engine.classify("What do you mean?").preferFreeForm,
			true,
		);
		assert.strictEqual(
			engine.classify("Design a system to handle 1M QPS").preferFreeForm,
			false,
		);
	});
});
