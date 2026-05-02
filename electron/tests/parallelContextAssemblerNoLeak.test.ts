import assert from "node:assert/strict";
import test from "node:test";

import {
	type ContextAssemblyInput,
	ParallelContextAssembler,
} from "../cache/ParallelContextAssembler";

// NAT-015 / audit R-3: prior to the fix, every `runInWorker` call spawned a
// new Node Worker thread that was never `terminate()`d, so each
// `assemble()` call leaked roughly three threads. We assert here that the
// active-handle count after a hundred sequential assemble() calls is in
// the same ballpark as a single warm-up call. We allow generous slack for
// timers and unrelated handles created by Node itself.

interface ProcessWithHandles extends NodeJS.Process {
	_getActiveHandles?: () => unknown[];
}

function activeHandleCount(): number {
	const proc = process as ProcessWithHandles;
	return proc._getActiveHandles?.().length ?? 0;
}

function makeInput(seed: number): ContextAssemblyInput {
	return {
		query: `seed ${seed} What is the best caching strategy?`,
		transcript: [
			{
				speaker: "interviewer",
				text: "Walk me through caches.",
				timestamp: Date.now() - 60_000,
			},
			{
				speaker: "user",
				text: "I would consider TTL and consistent hashing.",
				timestamp: Date.now() - 30_000,
			},
		],
		previousContext: { recentTopics: ["cache"], activeThread: null },
	};
}

test("ParallelContextAssembler does not leak Worker threads across assemble() calls", async () => {
	const assembler = new ParallelContextAssembler({ workerThreadCount: 2 });

	// Warm-up: prime any one-time JIT / resolver work so the baseline is honest.
	await assembler.assemble(makeInput(0));

	const baseline = activeHandleCount();

	for (let i = 1; i <= 100; i += 1) {
		await assembler.assemble(makeInput(i));
	}

	// Give the event loop a tick so any pending `terminate()` callbacks fire.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));

	const after = activeHandleCount();

	// Allow up to 10 handles of slack (timers, telemetry, etc.). Pre-fix the
	// delta was ~300 (3 workers × 100 calls).
	assert.equal(
		after - baseline <= 10,
		true,
		`active handles grew by ${after - baseline} (baseline=${baseline}, after=${after})`,
	);
});
