/**
 * NAT-207: Two-Tier Answer Contract CI gate.
 *
 * Asserts:
 *  (a) rootResponse.implementationPlan.length is constant after N probes
 *  (b) probes.length === N (capped at 8)
 *  (c) each probe answer satisfies probe_answer_v1 schema
 *  (d) delta.fact is deduped in root arrays
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsciousThreadStore } from '../conscious/ConsciousThreadStore';
import { parseProbeAnswer, PROBE_ANSWER_SCHEMA_VERSION } from '../coding/types';
import type { ProbeAnswer } from '../coding/types';
import { setOptimizationFlagsForTesting } from '../config/optimizations';
import { GOLDEN_ROOT_RESPONSE, GOLDEN_TRANSCRIPT } from './fixtures/goldenCodingInterviews';
import type { ReasoningThread } from '../ConsciousMode';

function makeProbe(question: string, answer: string, deltaMaybe?: { fact: string; attachTo: 'tradeoffs' | 'edgeCases' | 'implementationPlan' }): ProbeAnswer {
  return {
    schemaVersion: PROBE_ANSWER_SCHEMA_VERSION,
    probeType: 'generic',
    question,
    answer,
    delta: deltaMaybe,
    confidence: 0.9,
    createdAt: Date.now(),
  };
}

test('NAT-207: rootResponse.implementationPlan stays constant after 5 probe appends', () => {
  setOptimizationFlagsForTesting({ useTwoTierAnswerContract: true });

  const store = new ConsciousThreadStore();
  store.recordConsciousResponse('What is sliding window max?', GOLDEN_ROOT_RESPONSE, 'start');

  const rootLen = GOLDEN_ROOT_RESPONSE.implementationPlan.length;

  for (const turn of GOLDEN_TRANSCRIPT) {
    const probe = makeProbe(turn.question, 'So basically the complexity is O(n) amortised.');
    store.appendProbe(probe);
  }

  const thread = store.getActiveReasoningThread();
  assert.ok(thread, 'Active thread should exist');
  assert.equal(
    thread.response.implementationPlan.length,
    rootLen,
    'implementationPlan must not grow from probes when Two-Tier is ON',
  );
  assert.equal(thread.probes?.length, GOLDEN_TRANSCRIPT.length, `probes.length should be ${GOLDEN_TRANSCRIPT.length}`);
});

test('NAT-207: probes[] capped at 8 with LRU eviction', () => {
  setOptimizationFlagsForTesting({ useTwoTierAnswerContract: true });

  const store = new ConsciousThreadStore();
  store.recordConsciousResponse('Design a rate limiter', GOLDEN_ROOT_RESPONSE, 'start');

  for (let i = 0; i < 12; i++) {
    store.appendProbe(makeProbe(`Question ${i}`, `Answer ${i}`));
  }

  const thread = store.getActiveReasoningThread();
  assert.ok(thread);
  assert.equal(thread.probes?.length, 8, 'Probe buffer must be capped at 8');
  assert.equal(thread.probes![0].question, 'Question 4', 'Oldest 4 probes should have been evicted');
});

test('NAT-207: delta.fact is applied exactly once (deduped)', () => {
  setOptimizationFlagsForTesting({ useTwoTierAnswerContract: true });

  const store = new ConsciousThreadStore();
  store.recordConsciousResponse('Binary search on answer', GOLDEN_ROOT_RESPONSE, 'start');

  const fact = 'Binary search reduces time from O(n) to O(log n).';
  const probe = makeProbe('What is the complexity?', 'O(log n) since we binary search.', { fact, attachTo: 'tradeoffs' });
  store.appendProbe(probe);
  store.appendProbe(probe);

  const thread = store.getActiveReasoningThread();
  assert.ok(thread);
  const occurrences = thread.response.tradeoffs.filter((t) => t === fact).length;
  assert.equal(occurrences, 1, 'delta.fact must appear exactly once in root tradeoffs (dedup)');
});

test('NAT-207: parseProbeAnswer rejects malformed JSON', () => {
  const cases = [
    '',
    'not json at all',
    '{"schemaVersion":"probe_answer_v1"}',
    '{"answer":"hello"}',
    '{"answer":"","question":""}',
  ];
  for (const raw of cases) {
    const result = parseProbeAnswer(raw);
    assert.equal(result.success, false, `Expected failure for: ${JSON.stringify(raw)}`);
  }
});

test('NAT-207: parseProbeAnswer accepts valid probe JSON', () => {
  const valid = JSON.stringify({
    schemaVersion: 'probe_answer_v1',
    probeType: 'complexity',
    question: 'What is the time complexity?',
    answer: "It's O(n) amortised because each element is pushed and popped at most once.",
    confidence: 0.95,
  });
  const result = parseProbeAnswer(valid);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.schemaVersion, PROBE_ANSWER_SCHEMA_VERSION);
    assert.equal(result.data.probeType, 'complexity');
    assert.ok(result.data.answer.length > 0);
  }
});
