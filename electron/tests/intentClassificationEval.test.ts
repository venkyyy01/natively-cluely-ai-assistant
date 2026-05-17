import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeIntentEvalOutcomes,
  type IntentEvalOutcome,
} from '../evals/intentClassificationEval';

test('summarizeIntentEvalOutcomes computes accuracy, provider split, fallback rate, and confusion matrix', () => {
  const outcomes: IntentEvalOutcome[] = [
    {
      caseId: 'case-1',
      expectedIntent: 'behavioral',
      predictedIntent: 'behavioral',
      confidence: 0.91,
      providerUsed: 'foundation',
    },
    {
      caseId: 'case-2',
      expectedIntent: 'coding',
      predictedIntent: 'behavioral',
      confidence: 0.83,
      providerUsed: 'foundation',
    },
    {
      caseId: 'case-3',
      expectedIntent: 'coding',
      predictedIntent: 'coding',
      confidence: 0.56,
      providerUsed: 'legacy',
      fallbackReason: 'primary_failed',
    },
    {
      caseId: 'case-4',
      expectedIntent: 'follow_up',
      predictedIntent: 'follow_up',
      confidence: 0.42,
      providerUsed: 'legacy',
      fallbackReason: 'primary_retries_exhausted',
    },
  ];

  const summary = summarizeIntentEvalOutcomes(outcomes);

  assert.equal(summary.total, 4);
  assert.equal(summary.correct, 3);
  assert.equal(summary.accuracy, 0.75);

  assert.equal(summary.providerSplit.foundation, 2);
  assert.equal(summary.providerSplit.legacy, 2);

  assert.equal(summary.fallbackRate.count, 2);
  assert.equal(summary.fallbackRate.rate, 0.5);

  assert.equal(summary.perIntent.behavioral.total, 1);
  assert.equal(summary.perIntent.behavioral.correct, 1);
  assert.equal(summary.perIntent.coding.total, 2);
  assert.equal(summary.perIntent.coding.correct, 1);
  assert.equal(summary.perIntent.follow_up.total, 1);
  assert.equal(summary.perIntent.follow_up.correct, 1);

  assert.equal(summary.confusionMatrix.behavioral.behavioral, 1);
  assert.equal(summary.confusionMatrix.coding.behavioral, 1);
  assert.equal(summary.confusionMatrix.coding.coding, 1);
  assert.equal(summary.confusionMatrix.follow_up.follow_up, 1);

  const lowMidBucket = summary.confidenceBuckets.find((bucket) => bucket.label === '0.40-0.59');
  const highBucket = summary.confidenceBuckets.find((bucket) => bucket.label === '0.80-1.00');

  assert.ok(lowMidBucket);
  assert.ok(highBucket);
  assert.equal(lowMidBucket.count, 2);
  assert.equal(lowMidBucket.correct, 2);
  assert.equal(highBucket.count, 2);
  assert.equal(highBucket.correct, 1);
});

test('summarizeIntentEvalOutcomes handles empty outcome sets', () => {
  const summary = summarizeIntentEvalOutcomes([]);

  assert.equal(summary.total, 0);
  assert.equal(summary.correct, 0);
  assert.equal(summary.accuracy, 0);
  assert.equal(summary.fallbackRate.count, 0);
  assert.equal(summary.fallbackRate.rate, 0);
});
