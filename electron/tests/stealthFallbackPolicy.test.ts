import assert from "node:assert/strict";
import test from "node:test";

import { decideStealthFallback } from "../stealth/StealthFallbackPolicy";

test("StealthFallbackPolicy blocks Python fallback in strict production mode", () => {
	const decision = decideStealthFallback({
		kind: "python",
		env: { NODE_ENV: "production", NATIVELY_STRICT_PROTECTION: "1" },
	});

	assert.equal(decision.allow, false);
	assert.equal(decision.warning, "stealth_python_fallback_blocked");
});

test("StealthFallbackPolicy blocks Python fallback in production outside strict mode after native replacement", () => {
	const decision = decideStealthFallback({
		kind: "python",
		env: { NODE_ENV: "production" },
	});

	assert.equal(decision.allow, false);
	assert.equal(decision.production, true);
	assert.equal(decision.warning, "stealth_python_fallback_blocked");
});

test("StealthFallbackPolicy allows Python fallback in development with explicit diagnostics", () => {
	const decision = decideStealthFallback({
		kind: "python",
		env: { NODE_ENV: "development" },
	});

	assert.equal(decision.allow, true);
	assert.equal(decision.production, false);
	assert.match(decision.reason, /development/);
});

test("StealthFallbackPolicy blocks SCK audio fallback during an active external screen share", () => {
	const decision = decideStealthFallback({
		kind: "sck-audio",
		env: { NATIVELY_ALLOW_SCK_AUDIO_FALLBACK: "1" },
		activeScreenShare: true,
	});

	assert.equal(decision.allow, false);
	assert.equal(decision.warning, "sck_audio_fallback_blocked_active_share");
});

test("StealthFallbackPolicy requires explicit opt-in for SCK audio fallback", () => {
	const blocked = decideStealthFallback({ kind: "sck-audio", env: {} });
	const allowed = decideStealthFallback({
		kind: "sck-audio",
		env: { NATIVELY_ALLOW_SCK_AUDIO_FALLBACK: "1" },
	});

	assert.equal(blocked.allow, false);
	assert.equal(allowed.allow, true);
});
