import assert from "node:assert/strict";
import test from "node:test";

import {
	type BufferedUtterance,
	InterviewerUtteranceBuffer,
} from "../buffering/InterviewerUtteranceBuffer";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("InterviewerUtteranceBuffer merges final fragments and flushes on terminal punctuation", () => {
	const emitted: BufferedUtterance[] = [];
	const buffer = new InterviewerUtteranceBuffer({
		silenceMs: 1_000,
		maxBufferMs: 5_000,
		onUtterance: (utterance) => emitted.push(utterance),
	});

	assert.deepEqual(
		buffer.pushFragment("interviewer", "Can you explain", true),
		[],
	);
	const flushed = buffer.pushFragment(
		"interviewer",
		"the caching layer?",
		true,
	);

	assert.equal(flushed.length, 1);
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].text, "Can you explain the caching layer?");
	assert.equal(emitted[0].speaker, "interviewer");
	assert.equal(emitted[0].utteranceId, "utterance-1");
	assert.equal(emitted[0].flushReason, "punctuation");
	buffer.dispose();
});

test("InterviewerUtteranceBuffer deduplicates cumulative final fragments", () => {
	const emitted: BufferedUtterance[] = [];
	const buffer = new InterviewerUtteranceBuffer({
		silenceMs: 1_000,
		maxBufferMs: 5_000,
		onUtterance: (utterance) => emitted.push(utterance),
	});

	buffer.pushFragment("interviewer", "Walk me through", true);
	buffer.pushFragment("interviewer", "Walk me through the design?", true);

	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].text, "Walk me through the design?");
	buffer.dispose();
});

test("InterviewerUtteranceBuffer flushes on silence and speaker changes", async () => {
	const emitted: BufferedUtterance[] = [];
	const buffer = new InterviewerUtteranceBuffer({
		silenceMs: 20,
		maxBufferMs: 5_000,
		onUtterance: (utterance) => emitted.push(utterance),
	});

	buffer.pushFragment(
		"interviewer",
		"Tell me about a time you handled conflict",
		true,
	);
	await wait(30);

	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].flushReason, "silence");
	assert.equal(emitted[0].text, "Tell me about a time you handled conflict");

	buffer.pushFragment("interviewer", "How would you design", true);
	buffer.pushFragment("user", "I would start with requirements", true);

	assert.equal(emitted.length, 2);
	assert.equal(emitted[1].flushReason, "speaker_change");
	assert.equal(emitted[1].text, "How would you design");
	buffer.dispose();
});

test("InterviewerUtteranceBuffer splits multi-question turns at sentence boundaries", () => {
	const emitted: BufferedUtterance[] = [];
	const buffer = new InterviewerUtteranceBuffer({
		silenceMs: 1_000,
		maxBufferMs: 5_000,
		onUtterance: (utterance) => emitted.push(utterance),
	});

	buffer.pushFragment(
		"interviewer",
		"Tell me about a project you led. Also, what did you learn?",
		true,
	);

	assert.equal(emitted.length, 2);
	assert.equal(emitted[0].text, "Tell me about a project you led.");
	assert.equal(emitted[1].text, "Also, what did you learn?");
	assert.equal(emitted[0].utteranceId, "utterance-1");
	assert.equal(emitted[1].utteranceId, "utterance-1:2");
	buffer.dispose();
});
