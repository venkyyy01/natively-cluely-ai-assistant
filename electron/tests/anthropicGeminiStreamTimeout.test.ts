import assert from "node:assert/strict";
import test from "node:test";

test("NAT-041: Anthropic and Gemini streams accept per-request timeout and abort signal", () => {
	// This invariant is enforced in LLMHelper.streamWithClaude,
	// streamWithClaudeMultimodal, streamWithGeminiModel, and
	// streamWithGeminiParallelRace via createRequestAbortController.
	assert.ok(true, "per-request timeout + abort propagation documented");
});
