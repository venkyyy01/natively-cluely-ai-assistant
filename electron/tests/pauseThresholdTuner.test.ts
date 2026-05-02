import assert from "node:assert/strict";
import test from "node:test";
import type { PauseConfidence } from "../pause/PauseDetector";
import { PauseThresholdTuner } from "../pause/PauseThresholdTuner";

function confidence(silenceMs: number): PauseConfidence {
	return {
		score: 0.82,
		silenceMs,
		signals: [],
	};
}

test("PauseThresholdTuner becomes more conservative after false-positive resumes", () => {
	const tuner = new PauseThresholdTuner();
	const baseline = tuner.getConfig();

	tuner.recordFalsePositiveResume("hard_speculate", confidence(420));
	tuner.recordFalsePositiveResume("commit", confidence(460));

	const adjusted = tuner.getConfig();
	assert(adjusted.minSilenceMs > baseline.minSilenceMs);
	assert(adjusted.hardSpeculateThreshold > baseline.hardSpeculateThreshold);
	assert(adjusted.commitThreshold > baseline.commitThreshold);
});

test("PauseThresholdTuner becomes more aggressive after successful speculative reuse", () => {
	const tuner = new PauseThresholdTuner();
	tuner.recordFalsePositiveResume("hard_speculate", confidence(500));
	const cautious = tuner.getConfig();

	tuner.recordSuccessfulReuse(confidence(980));
	tuner.recordSuccessfulReuse(confidence(1040));

	const adjusted = tuner.getConfig();
	assert(adjusted.minSilenceMs <= cautious.minSilenceMs);
	assert(adjusted.hardSpeculateThreshold <= cautious.hardSpeculateThreshold);
	assert(adjusted.commitThreshold <= cautious.commitThreshold);
});
