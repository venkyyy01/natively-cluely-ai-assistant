import assert from "node:assert/strict";
import test from "node:test";
import { InterviewerUtteranceBuffer } from "../buffering/InterviewerUtteranceBuffer";
import {
	getTranscriptSuggestionDecision,
	maybeHandleSuggestionTriggerFromTranscript,
	type TranscriptSuggestionInput,
	type TranscriptSuggestionIntelligenceManager,
} from "../ConsciousMode";
import { setOptimizationFlagsForTesting } from "../config/optimizations";
import { TriggerAuditLog } from "../observability/TriggerAuditLog";

function buildManager(): {
	manager: TranscriptSuggestionIntelligenceManager;
	triggers: Array<{
		context: string;
		lastQuestion: string;
		confidence: number;
		sourceUtteranceId?: string;
	}>;
} {
	const triggers: Array<{
		context: string;
		lastQuestion: string;
		confidence: number;
		sourceUtteranceId?: string;
	}> = [];
	return {
		triggers,
		manager: {
			getActiveReasoningThread: () => null,
			getFormattedContext: () => "ctx",
			handleSuggestionTrigger: async (trigger) => {
				triggers.push(trigger);
			},
		},
	};
}

function buildInput(
	manager: TranscriptSuggestionIntelligenceManager,
	overrides: Partial<TranscriptSuggestionInput> = {},
): TranscriptSuggestionInput {
	return {
		speaker: "interviewer",
		text: "Walk me through the design?",
		final: true,
		confidence: 0.9,
		consciousModeEnabled: true,
		intelligenceManager: manager,
		...overrides,
	};
}

test("fallback trigger uses punctuation, question prefixes, and buffer flush instead of raw word count", () => {
	assert.equal(
		getTranscriptSuggestionDecision(
			"five plain words without question",
			false,
			null,
		).shouldTrigger,
		false,
	);
	assert.equal(
		getTranscriptSuggestionDecision("Can you repeat that for me", false, null)
			.shouldTrigger,
		true,
	);
	assert.equal(
		getTranscriptSuggestionDecision(
			"Walk me through the cache design",
			false,
			null,
		).shouldTrigger,
		true,
	);
	assert.equal(
		getTranscriptSuggestionDecision(
			"plain buffered statement",
			false,
			null,
			true,
		).shouldTrigger,
		false,
	);
});

test("useUtteranceLevelTriggering buffers fragments and fires one merged trigger on flush", async () => {
	setOptimizationFlagsForTesting({ useUtteranceLevelTriggering: true });
	const { manager, triggers } = buildManager();
	const audit = new TriggerAuditLog({ persistEnabled: false });
	const utteranceBuffer = new InterviewerUtteranceBuffer({
		silenceMs: 5_000,
		maxBufferMs: 10_000,
	});

	const first = await maybeHandleSuggestionTriggerFromTranscript(
		buildInput(manager, {
			text: "Walk me through",
			utteranceBuffer,
			triggerAuditLog: audit,
		}),
	);

	const second = await maybeHandleSuggestionTriggerFromTranscript(
		buildInput(manager, {
			text: "the cache design?",
			utteranceBuffer,
			triggerAuditLog: audit,
		}),
	);

	assert.equal(first, false);
	assert.equal(second, true);
	assert.deepEqual(triggers, [
		{
			context: "ctx",
			lastQuestion: "Walk me through the cache design?",
			confidence: 0.9,
			sourceUtteranceId: "utterance-1",
		},
	]);
	assert.deepEqual(
		audit.getEntries().map((entry) => entry.reasonCode),
		["declined_no_punctuation", "fired", "completed"],
	);
	utteranceBuffer.dispose();
});

test("utterance-level triggering handles multi-question interviewer turns", async () => {
	setOptimizationFlagsForTesting({ useUtteranceLevelTriggering: true });
	const { manager, triggers } = buildManager();
	const utteranceBuffer = new InterviewerUtteranceBuffer({
		silenceMs: 5_000,
		maxBufferMs: 10_000,
	});

	const triggered = await maybeHandleSuggestionTriggerFromTranscript(
		buildInput(manager, {
			text: "Tell me about a project you led. Also, what did you learn?",
			utteranceBuffer,
		}),
	);

	assert.equal(triggered, true);
	assert.deepEqual(
		triggers.map((trigger) => trigger.lastQuestion),
		["Tell me about a project you led.", "Also, what did you learn?"],
	);
	assert.deepEqual(
		triggers.map((trigger) => trigger.sourceUtteranceId),
		["utterance-1", "utterance-1:2"],
	);
	utteranceBuffer.dispose();
});

test("user mic transcript triggers are rejected by default and accepted behind flag", async () => {
	const rejected = buildManager();
	setOptimizationFlagsForTesting({ useMicTranscriptTriggers: false });
	assert.equal(
		await maybeHandleSuggestionTriggerFromTranscript(
			buildInput(rejected.manager, {
				speaker: "user",
				text: "How would you design this?",
			}),
		),
		false,
	);
	assert.equal(rejected.triggers.length, 0);

	const accepted = buildManager();
	setOptimizationFlagsForTesting({ useMicTranscriptTriggers: true });
	assert.equal(
		await maybeHandleSuggestionTriggerFromTranscript(
			buildInput(accepted.manager, {
				speaker: "user",
				text: "How would you design this?",
			}),
		),
		true,
	);
	assert.equal(accepted.triggers.length, 1);
});
