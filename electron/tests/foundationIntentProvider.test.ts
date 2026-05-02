import assert from "node:assert/strict";
import test from "node:test";

import { mapExitFailure } from "../llm/providers/FoundationModelsIntentProvider";

test("NAT-052: mapExitFailure prefers structured JSON on stderr", () => {
	assert.equal(
		mapExitFailure('{"kind":"model_not_ready","message":"warmup"}'),
		"model_not_ready",
	);
	assert.equal(mapExitFailure('{"errorType":"rate_limited"}'), "rate_limited");
	assert.equal(
		mapExitFailure('{"kind":"invalid_response"}'),
		"invalid_response",
	);
});

test("NAT-052: mapExitFailure falls back to narrow heuristics when JSON missing", () => {
	assert.equal(mapExitFailure("model_not_ready: system"), "model_not_ready");
	assert.equal(mapExitFailure("rate_limited by provider"), "rate_limited");
	assert.equal(mapExitFailure("something rate something"), "unknown");
});
