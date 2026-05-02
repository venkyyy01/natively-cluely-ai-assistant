import assert from "node:assert/strict";
import test from "node:test";

import { Metrics } from "../runtime/Metrics";

test("NAT-086: Metrics counter and gauge populate getSnapshot", () => {
	Metrics.resetForTests();
	Metrics.counter("intent.duplicate_classify_count", 1);
	Metrics.gauge("stream.cancel_latency_ms", 42);
	const snap = Metrics.getSnapshot();
	assert.equal(snap.counters["intent.duplicate_classify_count"], 1);
	assert.equal(snap.gauges["stream.cancel_latency_ms"], 42);
});
