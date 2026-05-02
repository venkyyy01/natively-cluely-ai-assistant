import assert from "node:assert/strict";
import test from "node:test";
import {
	prepareTranscriptForReasoning,
	prepareTranscriptForWhatToAnswer,
} from "../llm/transcriptCleaner";

test("prepareTranscriptForReasoning preserves technical identifiers and casing", () => {
	const now = Date.now();
	const turns = [
		{
			role: "interviewer" as const,
			text: "Can you debug LRUCache on S3 when SQL timeout throws ECONNRESET?",
			timestamp: now - 2000,
		},
		{
			role: "user" as const,
			text: 'Stack trace: TypeError at parseSQLRow -> LRUCache.get("S3Key")',
			timestamp: now - 1000,
		},
	];

	const reasoningPrepared = prepareTranscriptForReasoning(turns, 12);
	assert.match(reasoningPrepared, /LRUCache/);
	assert.match(reasoningPrepared, /S3/);
	assert.match(reasoningPrepared, /SQL/);
	assert.match(reasoningPrepared, /ECONNRESET/);
	assert.match(reasoningPrepared, /TypeError/);
});

test("NAT-044: prepareTranscriptForWhatToAnswer preserves original casing", () => {
	// Pre-NAT-044: cleanText() lowercased every token, so the LLM saw
	// "lrucache", "s3", "econnreset" and had to re-guess capitalization
	// for proper nouns and acronyms — frequently incorrectly. The fix
	// does case-insensitive filler matching but never mutates the surface
	// form of kept tokens.
	const now = Date.now();
	const turns = [
		{
			role: "interviewer" as const,
			text: "Can you debug LRUCache on S3 when SQL timeout throws ECONNRESET?",
			timestamp: now - 2000,
		},
		{
			role: "user" as const,
			text: "Stack trace: TypeError at parseSQLRow caused LRUCache.get to fail",
			timestamp: now - 1000,
		},
	];

	const standardPrepared = prepareTranscriptForWhatToAnswer(turns, 12);
	assert.match(standardPrepared, /LRUCache/);
	assert.match(standardPrepared, /S3/);
	assert.match(standardPrepared, /SQL/);
	assert.match(standardPrepared, /ECONNRESET/);
	assert.match(standardPrepared, /TypeError/);
});

test("NAT-044: cleanText still strips fillers/acknowledgements case-insensitively", () => {
	// The surface form is preserved, but membership in the filler /
	// acknowledgement sets is checked on the lowercased token. So an
	// input "Yeah, OK basically you know LRUCache" must drop "Yeah",
	// "OK", "basically", and "you know" while keeping "LRUCache" intact.
	const now = Date.now();
	const prepared = prepareTranscriptForWhatToAnswer(
		[
			{
				role: "interviewer" as const,
				text: "Yeah OK basically you know LRUCache then S3 fails",
				timestamp: now,
			},
		],
		12,
	);
	assert.match(prepared, /LRUCache/);
	assert.match(prepared, /S3/);
	assert.doesNotMatch(prepared, /\bYeah\b/i);
	assert.doesNotMatch(prepared, /\bbasically\b/i);
});
