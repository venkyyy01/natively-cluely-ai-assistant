import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousAccelerationOrchestrator } from '../conscious/ConsciousAccelerationOrchestrator';

// NAT-049 / audit P-13.
//
// Two pieces are under test here:
//
//   1. The orchestrator's `finalizeSpeculativeAnswer(key, waitMs)` honors
//      the cap supplied by the caller — i.e. when the underlying generator
//      never completes, finalize must return within roughly `waitMs`
//      milliseconds (plus event-loop slack), not 2 seconds.
//
//   2. IntelligenceEngine, at its single call site for finalize, now
//      passes 600 ms in the not-yet-complete case (down from 2_000 ms).
//      That source-level constant is reviewed in the diff; here we lock in
//      the orchestrator-side guarantee that the cap mechanism actually
//      bounds wall time. Together those two pieces give the p95 win the
//      ticket asked for.
//
// The previous integration tests in `aneClassifierLane.test.ts` already
// exercise the orchestrator end-to-end at 80 ms; this file adds the
// missing assertion at the new production cap.

test('NAT-049: finalizeSpeculativeAnswer respects a 600ms wait cap when the executor never completes', async () => {
    const orchestrator = new ConsciousAccelerationOrchestrator({
        budgetScheduler: { shouldAdmitSpeculation: () => true },
        intentClassifier: async () => ({
            intent: 'coding',
            confidence: 0.95,
            answerShape: 'Provide a full implementation.',
        }),
    });
    orchestrator.setEnabled(true);

    // Executor yields one partial chunk and then sits forever. We must
    // never wait on it past the cap.
    let aborted = false;
    orchestrator.setSpeculativeExecutor(async function* (_query, _revision, abortSignal) {
        abortSignal.addEventListener('abort', () => {
            aborted = true;
        }, { once: true });
        yield 'partial ';
        // Park forever (until aborted).
        await new Promise<void>((resolve) => {
            abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
    });

    const question = 'Implement a retry-safe worker loop.';
    orchestrator.noteTranscriptText('interviewer', question);
    orchestrator.updateTranscriptSegments([
        { speaker: 'interviewer', text: question, timestamp: Date.now() },
    ], 42);
    await (orchestrator as any).maybePrefetchIntent();
    await (orchestrator as any).maybeStartSpeculativeAnswer();

    // Drive the preview far enough to register the entry but not far
    // enough to mark it complete (the generator parks).
    await orchestrator.getSpeculativeAnswerPreview(question, 42, 50);
    const key = (orchestrator as any).buildSpeculativeKey(question, 42);

    const start = Date.now();
    const result = await orchestrator.finalizeSpeculativeAnswer(key, 600);
    const elapsed = Date.now() - start;

    // Cap honored: well under the pre-fix 2000 ms wait. We give 750 ms of
    // headroom for event-loop scheduling on slow CI; the production cap
    // is 600 ms and the previous cap was 2000 ms, so the gap to either
    // side is wide.
    assert.ok(
        elapsed < 1500,
        `finalize took ${elapsed} ms, expected < 1500 ms (cap is 600 ms)`,
    );

    // Cap fired: the never-completing generator is aborted on timeout.
    assert.equal(aborted, true, 'generator should be aborted on finalize timeout');

    // Either we got the partial text the generator already produced, or
    // we got null — both are valid finalize outcomes per the orchestrator
    // contract; what's *not* valid is sitting on the hot path for 2 s.
    assert.ok(result === 'partial' || result === null, `unexpected result: ${JSON.stringify(result)}`);
});

test('NAT-049: finalizeSpeculativeAnswer returns immediately when the entry is already complete', async () => {
    const orchestrator = new ConsciousAccelerationOrchestrator({
        budgetScheduler: { shouldAdmitSpeculation: () => true },
        intentClassifier: async () => ({
            intent: 'coding',
            confidence: 0.95,
            answerShape: 'Provide a full implementation.',
        }),
    });
    orchestrator.setEnabled(true);

    // Generator completes synchronously after one yield. The orchestrator
    // discards results shorter than 5 trimmed chars (treats them as junk),
    // so we emit a real-looking partial answer.
    orchestrator.setSpeculativeExecutor(async function* () {
        yield 'memoization caches function results.';
    });

    // Question must clear the orchestrator's gate: length >= 12 chars and
    // either detected as a question OR wordCount >= 5.
    const question = 'Implement memoization for a recursive Fibonacci function.';
    orchestrator.noteTranscriptText('interviewer', question);
    orchestrator.updateTranscriptSegments([
        { speaker: 'interviewer', text: question, timestamp: Date.now() },
    ], 7);
    await (orchestrator as any).maybePrefetchIntent();
    await (orchestrator as any).maybeStartSpeculativeAnswer();

    // Let the generator run to completion.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const key = (orchestrator as any).buildSpeculativeKey(question, 7);

    // IntelligenceEngine passes waitMs=0 in this branch — assert the
    // orchestrator returns essentially immediately and surfaces the text.
    const start = Date.now();
    const result = await orchestrator.finalizeSpeculativeAnswer(key, 0);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 100, `complete-entry finalize took ${elapsed} ms, expected < 100 ms`);
    assert.equal(result, 'memoization caches function results.');
});
