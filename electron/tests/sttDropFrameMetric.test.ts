// electron/tests/sttDropFrameMetric.test.ts
//
// NAT-021 / audit R-11: Every STT provider drops audio under
// backpressure (ring-buffer overwrite, or `Buffer[].shift()` once a
// soft cap is hit). Pre-NAT-021 those drops were silent — we observed
// "STT got worse" without any operator-visible counter. This file
// pins the `DropFrameMetric` contract that every provider now wires
// into:
//
//   1. `recordDrop()` accumulates into a window counter and a
//      cumulative counter.
//   2. `flush(force=false)` only emits when there were drops and
//      then resets the window counter (cumulative is monotonic).
//   3. `start()` is idempotent; `stop()` cancels the periodic timer
//      and emits a final flush by default.
//   4. The emitted line is the documented stable shape so an external
//      collector can scrape it (`provider=`, `dropped=`, `cumulative=`).

import assert from "node:assert/strict";
import test from "node:test";

import { DropFrameMetric } from "../audio/dropMetrics";

function buildHarness(provider = "deepgram") {
	const logged: string[] = [];
	const logger = {
		warn(msg: string) {
			logged.push(msg);
		},
	};
	let nowMs = 1_700_000_000_000;
	const metric = new DropFrameMetric({
		provider,
		flushIntervalMs: 5_000,
		logger,
		now: () => nowMs,
		setInterval: ((_fn: () => void, _ms: number) => {
			// Tests drive flush() directly; the periodic timer is irrelevant
			// here. Returning a "timer" handle that does nothing keeps
			// start()/stop() honest without touching real timers.
			return { unref() {} } as unknown as NodeJS.Timeout;
		}) as unknown as typeof setInterval,
		clearInterval: (() => {}) as unknown as typeof clearInterval,
	});
	return {
		metric,
		logged,
		advanceMs(ms: number) {
			nowMs += ms;
		},
	};
}

test("NAT-021: recordDrop accumulates into window and cumulative counters", () => {
	const { metric } = buildHarness();

	metric.recordDrop();
	metric.recordDrop(3);

	const counters = metric.getCounters();
	assert.equal(counters.windowDropped, 4);
	assert.equal(counters.cumulativeDropped, 4);
});

test("NAT-021: recordDrop ignores non-positive counts", () => {
	const { metric } = buildHarness();

	metric.recordDrop(0);
	metric.recordDrop(-5);

	const counters = metric.getCounters();
	assert.equal(counters.windowDropped, 0);
	assert.equal(counters.cumulativeDropped, 0);
});

test("NAT-021: flush emits one stable line and resets window only", () => {
	const { metric, logged } = buildHarness("google");

	metric.recordDrop(7);
	metric.flush(false);

	assert.equal(logged.length, 1);
	const line = logged[0];
	assert.match(line, /\[stt\.dropped_frames\]/);
	assert.match(line, /provider=google/);
	assert.match(line, /dropped=7/);
	assert.match(line, /cumulative=7/);

	// Window resets, cumulative does not.
	const after = metric.getCounters();
	assert.equal(after.windowDropped, 0);
	assert.equal(after.cumulativeDropped, 7);

	// A second drop + flush keeps cumulative monotonic.
	metric.recordDrop(2);
	metric.flush(false);
	assert.equal(logged.length, 2);
	assert.match(logged[1], /dropped=2/);
	assert.match(logged[1], /cumulative=9/);
});

test("NAT-021: flush is a no-op when there were no drops", () => {
	const { metric, logged } = buildHarness();
	metric.flush(false);
	assert.equal(logged.length, 0);
});

test("NAT-021: stop emits a final flush iff there were pending drops", () => {
	const { metric, logged } = buildHarness("deepgram");
	metric.start();
	metric.recordDrop(11);
	metric.stop();
	assert.equal(logged.length, 1, "stop should emit one final line");
	assert.match(logged[0], /provider=deepgram/);
	assert.match(logged[0], /dropped=11/);

	// A second stop with no pending drops must not log again.
	metric.stop();
	assert.equal(logged.length, 1);
});

test("NAT-021: start is idempotent (calling twice does not double-flush)", () => {
	const { metric, logged } = buildHarness();
	metric.start();
	metric.start(); // second call should be a no-op
	metric.recordDrop(1);
	metric.flush(false);
	assert.equal(logged.length, 1);
});
