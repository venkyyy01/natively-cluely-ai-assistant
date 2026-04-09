import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PerformanceInstrumentation,
  setPerformanceInstrumentationForTesting,
} from '../runtime/PerformanceInstrumentation';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';

test('baseline benchmark probes capture a meeting activation, answer, stealth toggle, and stop cycle', async () => {
  const benchmarkDir = process.env.NATIVELY_BENCHMARK_DIR
    ?? await mkdtemp(join(tmpdir(), 'natively-benchmarks-'));
  const shouldCleanup = !process.env.NATIVELY_BENCHMARK_DIR;
  const instrumentation = new PerformanceInstrumentation({ logDirectory: benchmarkDir });
  setPerformanceInstrumentationForTesting(instrumentation);

  try {
    const activationStartedAt = Date.now() - 25;
    instrumentation.recordDuration('meeting.activation', activationStartedAt, { runtime: 'legacy' });

    const tracker = new AnswerLatencyTracker();
    const requestId = tracker.start('fast_standard_answer', 'streaming');
    tracker.markFirstStreamingUpdate(requestId);
    tracker.complete(requestId);

    const stealthStartedAt = Date.now() - 5;
    instrumentation.recordDuration('stealth.toggle', stealthStartedAt, { enabled: true });

    const deactivationStartedAt = Date.now() - 10;
    instrumentation.recordDuration('meeting.deactivation', deactivationStartedAt, { runtime: 'legacy' });

    await instrumentation.flush();

    const events = await instrumentation.readAll();
    const metrics = events.map((event) => event.metric);
    assert.ok(metrics.includes('meeting.activation'));
    assert.ok(metrics.includes('answer.firstVisible'));
    assert.ok(metrics.includes('stealth.toggle'));
    assert.ok(metrics.includes('meeting.deactivation'));
    assert.ok(events.every((event) => typeof event.recordedAt === 'number'));
    assert.ok(events.every((event) => event.durationMs === undefined || event.durationMs >= 0));
  } finally {
    setPerformanceInstrumentationForTesting(null);
    if (shouldCleanup) {
      await rm(benchmarkDir, { recursive: true, force: true });
    }
  }
});
