import test from 'node:test';
import assert from 'node:assert/strict';

import { ConsciousResponseCoordinator } from '../conscious/ConsciousResponseCoordinator';
import { ResponseFingerprinter } from '../conscious/ResponseFingerprint';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';

interface RecordedEmission {
  type: 'token' | 'final';
  payload: string;
}

function buildHarness(fingerprinter?: ResponseFingerprinter) {
  const emissions: RecordedEmission[] = [];
  const sessionMessages: string[] = [];
  const usagePushes: string[] = [];
  const modeChanges: string[] = [];
  const tracker = new AnswerLatencyTracker();

  const coordinator = new ConsciousResponseCoordinator(
    {
      addAssistantMessage: (answer) => sessionMessages.push(answer),
      pushUsage: (entry) => usagePushes.push(entry.answer),
    },
    tracker,
    {
      emit: (event: 'suggested_answer_token' | 'suggested_answer', answer: string) => {
        emissions.push({
          type: event === 'suggested_answer_token' ? 'token' : 'final',
          payload: answer,
        });
        return true;
      },
    },
    (mode) => modeChanges.push(mode),
    fingerprinter,
  );

  return { coordinator, tracker, emissions, sessionMessages, usagePushes, modeChanges };
}

test('NAT-048: identical consecutive answers result in a single emission', () => {
  const fingerprinter = new ResponseFingerprinter(20, 0);
  const harness = buildHarness(fingerprinter);

  const answer = 'I would partition the queue by tenant, with a per-tenant rate cap and a shared overflow shelf.';

  const requestId1 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: requestId1,
    questionLabel: 'How would you design a multi-tenant queue?',
    confidence: 0.9,
    fullAnswer: answer,
  });

  const firstFinalCount = harness.emissions.filter((e) => e.type === 'final').length;
  assert.equal(firstFinalCount, 1, 'first answer must be emitted normally');
  assert.equal(harness.sessionMessages.length, 1);
  assert.equal(harness.usagePushes.length, 1);

  // Second emission with the SAME text — must be suppressed.
  const requestId2 = harness.tracker.start('conscious_answer', 'streaming');
  const ret = harness.coordinator.completeStructuredAnswer({
    requestId: requestId2,
    questionLabel: 'How would you design a multi-tenant queue?',
    confidence: 0.9,
    fullAnswer: answer,
  });

  const finalEmissions = harness.emissions.filter((e) => e.type === 'final');
  const tokenEmissions = harness.emissions.filter((e) => e.type === 'token');
  assert.equal(finalEmissions.length, 1, 'duplicate must not produce a second final emission');
  assert.equal(
    tokenEmissions.filter((e) => e.payload === answer).length,
    1,
    'duplicate must not produce additional token emissions for the same payload',
  );
  assert.equal(harness.sessionMessages.length, 1, 'session must not double-record the same answer');
  assert.equal(harness.usagePushes.length, 1, 'usage must not double-count the duplicate');
  assert.equal(harness.tracker.getSnapshot(requestId2)?.terminalStatus, 'suppressed');
  assert.equal(harness.tracker.getSnapshot(requestId2)?.suppressionReason, 'duplicate_answer');
  // Backward-compat: the call still returns the input answer for telemetry.
  assert.equal(ret, answer);
});

test('NAT-048: near-duplicate (same first sentence) is also suppressed', () => {
  const fingerprinter = new ResponseFingerprinter(20, 0);
  const harness = buildHarness(fingerprinter);

  const first =
    'I would partition the queue by tenant. Then add a per-tenant rate cap.';
  const nearDuplicate =
    'I would partition the queue by tenant. Then introduce a circuit breaker per tenant.';

  const r1 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r1,
    questionLabel: 'queue design',
    confidence: 0.9,
    fullAnswer: first,
  });

  const r2 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r2,
    questionLabel: 'queue design',
    confidence: 0.9,
    fullAnswer: nearDuplicate,
  });

  // ResponseFingerprinter.isDuplicate uses a 40-char first-sentence prefix
  // match for fuzzy detection; both answers share `I would partition the
  // queue by tenant` (>40 chars before the period), so the second one is
  // suppressed.
  const finalEmissions = harness.emissions.filter((e) => e.type === 'final');
  assert.equal(finalEmissions.length, 1);
  assert.equal(finalEmissions[0].payload, first);
});

test('NAT-048: distinct answers are both emitted', () => {
  const fingerprinter = new ResponseFingerprinter(20, 0);
  const harness = buildHarness(fingerprinter);

  const first = 'I would use a leader-follower replication topology with quorum writes.';
  const second = 'For the cache layer, an LRU with a 90-second TTL prevents stampedes.';

  const r1 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r1,
    questionLabel: 'design',
    confidence: 0.9,
    fullAnswer: first,
  });

  const r2 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r2,
    questionLabel: 'design',
    confidence: 0.9,
    fullAnswer: second,
  });

  const finalEmissions = harness.emissions.filter((e) => e.type === 'final');
  assert.equal(finalEmissions.length, 2);
  assert.equal(finalEmissions[0].payload, first);
  assert.equal(finalEmissions[1].payload, second);
});

test('NAT-048: with no fingerprinter injected, behavior matches the legacy contract', () => {
  // Backward-compat regression check: existing callers that construct a
  // coordinator without a fingerprinter must keep getting one-emission-
  // per-call, including for repeated identical inputs.
  const harness = buildHarness();

  const answer = 'foo bar baz qux';
  const r1 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r1,
    questionLabel: 'q',
    confidence: 1,
    fullAnswer: answer,
  });
  const r2 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r2,
    questionLabel: 'q',
    confidence: 1,
    fullAnswer: answer,
  });

  const finalEmissions = harness.emissions.filter((e) => e.type === 'final');
  assert.equal(finalEmissions.length, 2, 'no fingerprinter ⇒ no suppression');
});

test('NAT-048: clearing the fingerprinter (e.g. on session switch) re-allows previously-seen answers', () => {
  const fingerprinter = new ResponseFingerprinter(20, 0);
  const harness = buildHarness(fingerprinter);

  const answer = 'I would shard the database by user_id with consistent hashing.';

  const r1 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r1,
    questionLabel: 'q',
    confidence: 0.9,
    fullAnswer: answer,
  });

  // Within the same fingerprint window — suppressed.
  const r2 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r2,
    questionLabel: 'q',
    confidence: 0.9,
    fullAnswer: answer,
  });
  assert.equal(harness.emissions.filter((e) => e.type === 'final').length, 1);

  // Simulate session switch: engine clears the fingerprinter. Now a new
  // user/turn with similar phrasing must NOT be suppressed.
  fingerprinter.clear();

  const r3 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r3,
    questionLabel: 'q',
    confidence: 0.9,
    fullAnswer: answer,
  });
  assert.equal(harness.emissions.filter((e) => e.type === 'final').length, 2);
});

test('NAT-048: the same answer can be emitted again for a different question', () => {
  const fingerprinter = new ResponseFingerprinter(20, 0);
  const harness = buildHarness(fingerprinter);

  const answer = 'I would start with a token bucket and then add per-tenant quotas.';

  const r1 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r1,
    questionLabel: 'How would you rate limit this API?',
    confidence: 0.9,
    fullAnswer: answer,
  });

  const r2 = harness.tracker.start('conscious_answer', 'streaming');
  harness.coordinator.completeStructuredAnswer({
    requestId: r2,
    questionLabel: 'How would you protect this queue from bursts?',
    confidence: 0.9,
    fullAnswer: answer,
  });

  const finalEmissions = harness.emissions.filter((e) => e.type === 'final');
  assert.equal(finalEmissions.length, 2, 'question changes must reset duplicate suppression');
});
