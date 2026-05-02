import assert from "node:assert/strict";
import test from "node:test";
import {
	runConsciousEvalHarness,
	runConsciousReplayHarness,
} from "../conscious/ConsciousEvalHarness";
import { ConsciousVerifier } from "../conscious/ConsciousVerifier";

test("Conscious eval harness runs default scenarios and produces a summary", async () => {
	const { results, summary } = await runConsciousEvalHarness({
		verifier: new ConsciousVerifier(),
	});

	assert.equal(summary.total, results.length);
	assert.ok(summary.total > 0);
	assert.equal(summary.failed, 0);
	assert.ok(summary.byFamily.system_design.total > 0);
	assert.ok(summary.byFamily.behavioral.total > 0);
	assert.ok(summary.byFamily.provenance.total > 0);
});

test("Conscious replay harness reconstructs route, context, verifier, and fallback trace", async () => {
	const { results, summary } = await runConsciousReplayHarness({
		verifier: new ConsciousVerifier(),
	});

	assert.equal(summary.total, results.length);
	assert.equal(summary.failed, 0);
	assert.ok(summary.byFamily.system_design_continuation.total > 0);
	assert.ok(summary.byFamily.topic_shift.total > 0);
	assert.ok(results[0].trace.selectedContextItemIds.length > 0);
	assert.deepEqual(results[0].trace.route, {
		qualifies: true,
		threadAction: "continue",
	});
	assert.equal(results[0].trace.verifierVerdict.ok, true);
	assert.equal(results[0].trace.fallbackReason, undefined);
});
