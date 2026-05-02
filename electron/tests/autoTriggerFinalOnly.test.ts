import assert from "node:assert/strict";
import test from "node:test";

import {
	maybeHandleSuggestionTriggerFromTranscript,
	type TranscriptSuggestionInput,
	type TranscriptSuggestionIntelligenceManager,
} from "../ConsciousMode";

function buildIntelligenceManager(): {
	manager: TranscriptSuggestionIntelligenceManager;
	triggers: Array<{
		context: string;
		lastQuestion: string;
		confidence: number;
	}>;
} {
	const triggers: Array<{
		context: string;
		lastQuestion: string;
		confidence: number;
	}> = [];
	const manager: TranscriptSuggestionIntelligenceManager = {
		getActiveReasoningThread() {
			return null;
		},
		getFormattedContext() {
			return "";
		},
		async handleSuggestionTrigger(trigger) {
			triggers.push(trigger);
		},
	};
	return { manager, triggers };
}

function buildInput(
	manager: TranscriptSuggestionIntelligenceManager,
	overrides: Partial<TranscriptSuggestionInput> = {},
): TranscriptSuggestionInput {
	return {
		speaker: "interviewer",
		text: "Walk me through how you would design a high-throughput rate limiter.",
		final: true,
		confidence: 0.9,
		consciousModeEnabled: true,
		intelligenceManager: manager,
		...overrides,
	};
}

test("NAT-006 / audit A-6: interim transcript with high confidence does NOT trigger", async () => {
	const { manager, triggers } = buildIntelligenceManager();
	const input = buildInput(manager, { final: false, confidence: 0.95 });

	const triggered = await maybeHandleSuggestionTriggerFromTranscript(input);

	assert.equal(triggered, false);
	assert.equal(triggers.length, 0);
});

test("NAT-006 / audit A-6: interim transcript with low confidence does NOT trigger", async () => {
	const { manager, triggers } = buildIntelligenceManager();
	const input = buildInput(manager, { final: false, confidence: 0.4 });

	const triggered = await maybeHandleSuggestionTriggerFromTranscript(input);

	assert.equal(triggered, false);
	assert.equal(triggers.length, 0);
});

test("NAT-006 / audit A-6: final transcript with high confidence DOES trigger", async () => {
	const { manager, triggers } = buildIntelligenceManager();
	const input = buildInput(manager, { final: true, confidence: 0.92 });

	const triggered = await maybeHandleSuggestionTriggerFromTranscript(input);

	assert.equal(triggered, true);
	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].confidence, 0.92);
});

test("NAT-006: final transcript with low confidence does NOT trigger (belt-and-suspenders)", async () => {
	const { manager, triggers } = buildIntelligenceManager();
	const input = buildInput(manager, { final: true, confidence: 0.3 });

	const triggered = await maybeHandleSuggestionTriggerFromTranscript(input);

	assert.equal(triggered, false);
	assert.equal(triggers.length, 0);
});

test("NAT-006: final transcript with no confidence value still triggers", async () => {
	const { manager, triggers } = buildIntelligenceManager();
	const input = buildInput(manager, { final: true, confidence: undefined });

	const triggered = await maybeHandleSuggestionTriggerFromTranscript(input);

	assert.equal(triggered, true);
	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].confidence, 0.8);
});

test("NAT-006: non-interviewer speaker is rejected even when final", async () => {
	const { manager, triggers } = buildIntelligenceManager();
	const input = buildInput(manager, {
		speaker: "me",
		final: true,
		confidence: 0.9,
	});

	const triggered = await maybeHandleSuggestionTriggerFromTranscript(input);

	assert.equal(triggered, false);
	assert.equal(triggers.length, 0);
});
