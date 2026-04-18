import test from 'node:test';
import assert from 'node:assert/strict';

import type { IntentResult } from '../llm/IntentClassifier';
import {
  IntentClassificationCoordinator,
  type IntentClassificationCoordinatorOptions,
} from '../llm/providers/IntentClassificationCoordinator';
import {
  createIntentProviderError,
  type IntentClassificationInput,
  type IntentInferenceProvider,
} from '../llm/providers/IntentInferenceProvider';

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

const input: IntentClassificationInput = {
  lastInterviewerTurn: 'Tell me about a time you had a difficult conflict.',
  preparedTranscript: '[INTERVIEWER] Tell me about a time you had a difficult conflict.',
  assistantResponseCount: 1,
};

function behavioralResult(confidence = 0.9): IntentResult {
  return {
    intent: 'behavioral',
    confidence,
    answerShape: 'Tell one concrete story.',
  };
}

function codingResult(confidence = 0.9): IntentResult {
  return {
    intent: 'coding',
    confidence,
    answerShape: 'Provide full implementation.',
  };
}

test('IntentClassificationCoordinator uses primary provider first when available', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    return behavioralResult(0.93);
  });
  const fallback = new StubProvider('legacy', true, async () => {
    fallbackCalls += 1;
    return codingResult(0.7);
  });

  const coordinator = new IntentClassificationCoordinator(primary, fallback);
  const result = await coordinator.classify(input);

  assert.equal(result.intent, 'behavioral');
  assert.equal(result.provider, 'foundation');
  assert.equal(result.retryCount, 0);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test('IntentClassificationCoordinator falls back when primary is unavailable', async () => {
  let fallbackCalls = 0;
  const primary = new StubProvider('foundation', false, async () => behavioralResult());
  const fallback = new StubProvider('legacy', true, async () => {
    fallbackCalls += 1;
    return codingResult(0.88);
  });

  const coordinator = new IntentClassificationCoordinator(primary, fallback);
  const result = await coordinator.classify(input);

  assert.equal(result.intent, 'coding');
  assert.equal(result.provider, 'legacy');
  assert.equal(result.retryCount, 0);
  assert.equal(result.fallbackReason, 'primary_unavailable');
  assert.equal(fallbackCalls, 1);
});

test('IntentClassificationCoordinator retries transient primary failures with exponential backoff before fallback', async () => {
  const recordedDelays: number[] = [];
  let primaryCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    throw createIntentProviderError('rate_limited', 'temporarily rate-limited');
  });
  const fallback = new StubProvider('legacy', true, async () => codingResult(0.82));

  const options: IntentClassificationCoordinatorOptions = {
    maxPrimaryRetries: 2,
    baseBackoffMs: 100,
    jitterMs: 0,
    delayFn: async (ms: number) => {
      recordedDelays.push(ms);
    },
  };
  const coordinator = new IntentClassificationCoordinator(primary, fallback, options);
  const result = await coordinator.classify(input);

  assert.equal(primaryCalls, 3);
  assert.deepEqual(recordedDelays, [200, 400]);
  assert.equal(result.provider, 'legacy');
  assert.equal(result.retryCount, 2);
  assert.equal(result.fallbackReason, 'primary_retries_exhausted');
});

test('IntentClassificationCoordinator does not retry deterministic unavailable errors', async () => {
  let primaryCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    throw createIntentProviderError('unavailable', 'device not eligible');
  });
  const fallback = new StubProvider('legacy', true, async () => codingResult(0.76));

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    maxPrimaryRetries: 3,
    baseBackoffMs: 200,
    jitterMs: 0,
  });
  const result = await coordinator.classify(input);

  assert.equal(primaryCalls, 1);
  assert.equal(result.provider, 'legacy');
  assert.equal(result.retryCount, 0);
  assert.equal(result.fallbackReason, 'primary_unavailable');
});

test('IntentClassificationCoordinator marks deterministic non-unavailable failures as primary_failed', async () => {
  let primaryCalls = 0;
  const primary = new StubProvider('foundation', true, async () => {
    primaryCalls += 1;
    throw createIntentProviderError('invalid_response', 'bad json envelope');
  });
  const fallback = new StubProvider('legacy', true, async () => codingResult(0.81));

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    maxPrimaryRetries: 3,
    baseBackoffMs: 150,
    jitterMs: 0,
  });
  const result = await coordinator.classify(input);

  assert.equal(primaryCalls, 1);
  assert.equal(result.provider, 'legacy');
  assert.equal(result.retryCount, 0);
  assert.equal(result.fallbackReason, 'primary_failed');
});

test('IntentClassificationCoordinator falls back when primary confidence is below threshold', async () => {
  const lowConfidenceInput: IntentClassificationInput = {
    lastInterviewerTurn: 'Implement a queue retry worker in TypeScript.',
    preparedTranscript: '[INTERVIEWER]: Implement a queue retry worker in TypeScript.',
    assistantResponseCount: 0,
  };

  const primary = new StubProvider('foundation', true, async () => ({
    intent: 'behavioral',
    confidence: 0.71,
    answerShape: 'Tell one concrete story.',
  }));
  let fallbackCalls = 0;
  const fallback = new StubProvider('legacy', true, async () => {
    fallbackCalls += 1;
    return codingResult(0.87);
  });

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    minimumPrimaryConfidence: 0.82,
    contradictionDeltaConfidence: 0.18,
  });
  const result = await coordinator.classify(lowConfidenceInput);

  assert.equal(result.intent, 'coding');
  assert.equal(result.provider, 'legacy');
  assert.equal(result.fallbackReason, 'primary_contradiction');
  assert.equal(fallbackCalls, 1);
});

test('IntentClassificationCoordinator falls back on contradiction when fallback better matches cues', async () => {
  const contradictionInput: IntentClassificationInput = {
    lastInterviewerTurn: 'What happened next after you paused the deployment?',
    preparedTranscript: [
      '[ASSISTANT]: I paused the deploy and paged backend on-call.',
      '[INTERVIEWER]: What happened next after you paused the deployment?',
    ].join('\n'),
    assistantResponseCount: 1,
  };

  const primary = new StubProvider('foundation', true, async () => ({
    intent: 'behavioral',
    confidence: 0.85,
    answerShape: 'Use STAR.',
  }));
  let fallbackCalls = 0;
  const fallback = new StubProvider('legacy', true, async () => {
    fallbackCalls += 1;
    return {
      intent: 'follow_up',
      confidence: 0.93,
      answerShape: 'Continue narrative naturally.',
    };
  });

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    minimumPrimaryConfidence: 0.82,
    contradictionDeltaConfidence: 0.05,
  });
  const result = await coordinator.classify(contradictionInput);

  assert.equal(result.intent, 'follow_up');
  assert.equal(result.provider, 'legacy');
  assert.equal(result.fallbackReason, 'primary_contradiction');
  assert.equal(fallbackCalls, 1);
});

test('IntentClassificationCoordinator keeps primary on low confidence when fallback collapses to general but cues indicate non-general', async () => {
  const clarificationInput: IntentClassificationInput = {
    lastInterviewerTurn: 'Can you clarify what you meant by eventual consistency?',
    preparedTranscript: [
      '[ASSISTANT]: I use eventual consistency for replicas in this design.',
      '[INTERVIEWER]: Can you clarify what you meant by eventual consistency?',
    ].join('\n'),
    assistantResponseCount: 1,
  };

  const primary = new StubProvider('foundation', true, async () => ({
    intent: 'clarification',
    confidence: 0.58,
    answerShape: 'Give a direct clarification.',
  }));
  let fallbackCalls = 0;
  const fallback = new StubProvider('legacy', true, async () => {
    fallbackCalls += 1;
    return {
      intent: 'general',
      confidence: 0.5,
      answerShape: 'Respond naturally.',
    };
  });

  const coordinator = new IntentClassificationCoordinator(primary, fallback, {
    minimumPrimaryConfidence: 0.82,
    contradictionDeltaConfidence: 0.18,
  });
  const result = await coordinator.classify(clarificationInput);

  assert.equal(result.intent, 'clarification');
  assert.equal(result.provider, 'foundation');
  assert.equal(result.fallbackReason, undefined);
  assert.equal(fallbackCalls, 1);
});
