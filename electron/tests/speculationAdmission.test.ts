import assert from "node:assert/strict";
import test from "node:test";
import { setOptimizationFlags } from "../config/optimizations";
import { PredictivePrefetcher } from "../prefetch/PredictivePrefetcher";

test("PredictivePrefetcher admits speculation only when the runtime budget scheduler allows it", async () => {
	setOptimizationFlags({
		accelerationEnabled: true,
		usePrefetching: true,
		maxPrefetchPredictions: 3,
	});
	const prefetcher = new PredictivePrefetcher({
		maxPrefetchPredictions: 3,
		maxMemoryMB: 50,
		budgetScheduler: {
			shouldAdmitSpeculation() {
				return false;
			},
		},
	});

	prefetcher.updateTranscriptSegments([
		{
			speaker: "interviewer",
			text: "Let us talk about the main components and how they communicate.",
			timestamp: Date.now(),
		},
	]);
	prefetcher.onPhaseChange("high_level_design");
	prefetcher.onSilenceStart();

	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(prefetcher.getPredictions(), []);
	assert.equal(
		await prefetcher.getContext("What are the main components?"),
		null,
	);
});
