import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnswerLatencyTracker } from "../latency/AnswerLatencyTracker";
import {
	PerformanceInstrumentation,
	setPerformanceInstrumentationForTesting,
} from "../runtime/PerformanceInstrumentation";

test("baseline benchmark probes capture a meeting activation, answer, stealth toggle, and stop cycle", async () => {
	const benchmarkDir =
		process.env.NATIVELY_BENCHMARK_DIR ??
		(await mkdtemp(join(tmpdir(), "natively-benchmarks-")));
	const shouldCleanup = !process.env.NATIVELY_BENCHMARK_DIR;
	const originalDateNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	const instrumentation = new PerformanceInstrumentation({
		logDirectory: benchmarkDir,
		now: () => now,
	});
	setPerformanceInstrumentationForTesting(instrumentation);

	try {
		const activationStartedAt = Date.now() - 25;
		instrumentation.recordDuration("meeting.activation", activationStartedAt, {
			runtime: "coordinator",
		});

		const tracker = new AnswerLatencyTracker();
		const requestId = tracker.start("fast_standard_answer", "streaming");
		now += 37;
		tracker.markFirstStreamingUpdate(requestId);
		now += 11;
		tracker.complete(requestId);

		const stealthStartedAt = Date.now() - 5;
		instrumentation.recordDuration("stealth.toggle", stealthStartedAt, {
			enabled: true,
		});

		const deactivationStartedAt = Date.now() - 10;
		instrumentation.recordDuration(
			"meeting.deactivation",
			deactivationStartedAt,
			{ runtime: "coordinator" },
		);

		await instrumentation.flush();

		const events = await instrumentation.readAll();
		const metrics = new Map(
			events.map((event) => [event.metric, event.durationMs]),
		);
		assert.equal(metrics.get("meeting.activation"), 25);
		assert.equal(metrics.get("answer.firstVisible"), 37);
		assert.equal(metrics.get("stealth.toggle"), 5);
		assert.equal(metrics.get("meeting.deactivation"), 10);
		assert.ok(events.every((event) => typeof event.recordedAt === "number"));
		assert.ok(
			events.every(
				(event) => event.durationMs === undefined || event.durationMs >= 0,
			),
		);
	} finally {
		Date.now = originalDateNow;
		setPerformanceInstrumentationForTesting(null);
		if (shouldCleanup) {
			await rm(benchmarkDir, { recursive: true, force: true });
		}
	}
});
