import test from 'node:test';
import assert from 'node:assert/strict';

import { LayeredIntentRouter } from '../llm/LayeredIntentRouter';
import {
  __setSlmIntentClassifierForTesting,
  classifyIntent,
  getAnswerShapeGuidance,
} from '../llm/IntentClassifier';
import { SetFitIntentProvider } from '../llm/providers/SetFitIntentProvider';

const CONFLICTING_TECHNICAL_QUESTION =
  'How would you design a distributed systems rate limiting architecture and compare consistency, latency, and tradeoffs?';

test('classifyIntent keeps the legacy regex-first behavior for existing callers', async () => {
  __setSlmIntentClassifierForTesting(async () => ({
    intent: 'behavioral',
    confidence: 0.73,
    answerShape: getAnswerShapeGuidance('behavioral'),
  }));

  try {
    const result = await classifyIntent(CONFLICTING_TECHNICAL_QUESTION, '', 0);
    assert.equal(result.intent, 'deep_dive');
  } finally {
    __setSlmIntentClassifierForTesting(null);
  }
});

test('routeFast gives a reliable SLM result authority over conflicting regex cues', async () => {
  const originalIsAvailable = SetFitIntentProvider.prototype.isAvailable;
  SetFitIntentProvider.prototype.isAvailable = async () => false;

  __setSlmIntentClassifierForTesting(async () => ({
    intent: 'behavioral',
    confidence: 0.73,
    answerShape: getAnswerShapeGuidance('behavioral'),
  }));
  LayeredIntentRouter.resetForTesting();

  try {
    const decision = await LayeredIntentRouter.getInstance().routeFast({
      question: CONFLICTING_TECHNICAL_QUESTION,
      transcript: '',
      assistantResponseCount: 0,
    });

    const slmEntry = decision.ensemble.find((entry) => entry.provider === 'slm');
    const regexEntry = decision.ensemble.find((entry) => entry.provider === 'regex');

    assert.equal(slmEntry?.intent, 'behavioral');
    assert.equal(regexEntry?.intent, 'deep_dive');
    assert.equal(decision.intentResult.intent, 'behavioral');
    assert.equal(decision.layerName, 'ensemble');
    assert.equal(slmEntry?.used, true);
    assert.equal(regexEntry?.used, false);
  } finally {
    __setSlmIntentClassifierForTesting(null);
    SetFitIntentProvider.prototype.isAvailable = originalIsAvailable;
    LayeredIntentRouter.resetForTesting();
  }
});
