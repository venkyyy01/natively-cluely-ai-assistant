import test from 'node:test';
import assert from 'node:assert/strict';

import type { IntentResult } from '../llm/IntentClassifier';
import {
  IntentClassificationCoordinator,
} from '../llm/providers/IntentClassificationCoordinator';
import {
  type IntentClassificationInput,
  type IntentInferenceProvider,
} from '../llm/providers/IntentInferenceProvider';
import type { CoordinatedIntentResult } from '../llm/providers/IntentClassificationCoordinator';

function coreCoord(r: CoordinatedIntentResult) {
  return {
    intent: r.intent,
    confidence: r.confidence,
    answerShape: r.answerShape,
    provider: r.provider,
    retryCount: r.retryCount,
  };
}

class StubProvider implements IntentInferenceProvider {
  constructor(
    public readonly name: string,
    private readonly available: boolean,
    private readonly classifyImpl: (input: IntentClassificationInput) => Promise<IntentResult>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async classify(input: IntentClassificationInput): Promise<IntentResult> {
    return this.classifyImpl(input);
  }
}

function behavioralResult(confidence = 0.93): IntentResult {
  return {
    intent: 'behavioral',
    confidence,
    answerShape: 'Tell one concrete story.',
  };
}

function makeInput(overrides: Partial<IntentClassificationInput> = {}): IntentClassificationInput {
  return {
    lastInterviewerTurn: 'Tell me about a difficult conflict you handled.',
    preparedTranscript: '[INTERVIEWER] Tell me about a difficult conflict you handled.',
    assistantResponseCount: 1,
    transcriptRevision: 7,
    ...overrides,
  };
}

test('NAT-039: identical concurrent classify calls share a single primary invocation', async () => {
  let primaryCalls = 0;
  let resolveFirst: (value: IntentResult) => void = () => {};
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    return new Promise<IntentResult>((resolve) => {
      resolveFirst = resolve;
    });
  });
  const fallback = new StubProvider('legacy', true, async () => behavioralResult(0.6));

  const coordinator = new IntentClassificationCoordinator(primary, fallback);

  const input = makeInput();
  const p1 = coordinator.classify(input);
  const p2 = coordinator.classify(input);
  const p3 = coordinator.classify(input);

  // Let the first await on isAvailable / primary.classify schedule.
  await new Promise((r) => setImmediate(r));

  resolveFirst(behavioralResult(0.93));

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.equal(primaryCalls, 1, 'primary should only be invoked once across concurrent identical calls');
  assert.equal(r1.intent, 'behavioral');
  assert.equal(r1.provider, 'foundation');
  // NAT-056: staleness is stamped per caller (ageMs may differ); core fields match.
  assert.deepEqual(coreCoord(r1), coreCoord(r2));
  assert.deepEqual(coreCoord(r2), coreCoord(r3));
  assert.equal(r1.staleness?.transcriptRevision, 7);
  assert.equal(r2.staleness?.transcriptRevision, 7);
});

test('NAT-039: repeat classify within TTL returns cached promise without re-invoking primary', async () => {
  let primaryCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    return behavioralResult(0.93);
  });
  const fallback = new StubProvider('legacy', true, async () => behavioralResult(0.6));

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    dedupeTtlMs: 1000,
  });

  const input = makeInput();
  const r1 = await coordinator.classify(input);
  const r2 = await coordinator.classify(input);

  assert.equal(primaryCalls, 1, 'second call within TTL should hit the cache');
  assert.deepEqual(coreCoord(r1), coreCoord(r2));
  assert.equal(r1.intent, 'behavioral');
  assert.equal(r1.staleness?.transcriptRevision, 7);
});

test('NAT-039: bumped transcriptRevision invalidates the cache entry', async () => {
  let primaryCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    return behavioralResult(0.93);
  });
  const fallback = new StubProvider('legacy', true, async () => behavioralResult(0.6));

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    dedupeTtlMs: 1000,
  });

  await coordinator.classify(makeInput({ transcriptRevision: 7 }));
  await coordinator.classify(makeInput({ transcriptRevision: 8 }));

  assert.equal(primaryCalls, 2, 'a new revision must produce a fresh classify');
});

test('NAT-039: input without transcriptRevision bypasses dedupe entirely', async () => {
  let primaryCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    return behavioralResult(0.93);
  });
  const fallback = new StubProvider('legacy', true, async () => behavioralResult(0.6));

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    dedupeTtlMs: 1000,
  });

  const input = makeInput({ transcriptRevision: undefined });
  await coordinator.classify(input);
  await coordinator.classify(input);

  assert.equal(
    primaryCalls,
    2,
    'callers that have not provided a revision are not isolated and must not be served stale',
  );
});

test('NAT-039: TTL expiry triggers a fresh primary call', async () => {
  let now = 1_000_000;
  let primaryCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    return behavioralResult(0.93);
  });
  const fallback = new StubProvider('legacy', true, async () => behavioralResult(0.6));

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    dedupeTtlMs: 500,
    nowFn: () => now,
  });

  const input = makeInput();
  await coordinator.classify(input);
  // Within TTL: cache hit.
  now += 250;
  await coordinator.classify(input);
  assert.equal(primaryCalls, 1);

  // Past TTL: cache miss.
  now += 500;
  await coordinator.classify(input);
  assert.equal(primaryCalls, 2);
});

test('NAT-039: classify failures are evicted so the next caller can retry', async () => {
  let primaryCalls = 0;
  let shouldThrow = true;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    if (shouldThrow) {
      throw new Error('boom');
    }
    return behavioralResult(0.93);
  });
  // Force the fallback to also throw so the whole pipeline rejects.
  const fallback = new StubProvider('legacy', true, async () => {
    throw new Error('fallback exploded');
  });

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    maxPrimaryRetries: 0,
    baseBackoffMs: 0,
    jitterMs: 0,
    dedupeTtlMs: 1000,
  });

  const input = makeInput();
  await assert.rejects(coordinator.classify(input));

  shouldThrow = false;
  // Allow the eviction microtask attached via .catch() to flush before
  // the next call. Without this yield, the next caller would race against
  // the eviction and might still observe the rejected cached promise.
  await new Promise((r) => setImmediate(r));

  const result = await coordinator.classify(input);
  assert.equal(result.intent, 'behavioral');
  assert.equal(primaryCalls, 2, 'failed entry must not poison subsequent retries');
});
