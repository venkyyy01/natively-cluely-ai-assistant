import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerHypothesisStore } from '../conscious/AnswerHypothesisStore';
import type { ConsciousModeStructuredResponse } from '../ConsciousMode';

const response: ConsciousModeStructuredResponse = {
  mode: 'reasoning_first',
  openingReasoning: 'I would start with tenant partitioning.',
  implementationPlan: ['Partition by tenant', 'Aggregate into read models'],
  tradeoffs: ['Cross-tenant queries are more expensive'],
  edgeCases: ['One tenant can become disproportionately large'],
  scaleConsiderations: ['Promote hot tenants to dedicated partitions'],
  pushbackResponses: ['The model keeps writes simple while isolating noisy tenants.'],
  likelyFollowUps: [],
  codeTransition: '',
};

test('AnswerHypothesisStore builds inferred answer state from suggestion and reaction', () => {
  const store = new AnswerHypothesisStore();
  store.recordStructuredSuggestion('How would you partition a multi-tenant analytics system?', response, 'start');
  store.noteObservedReaction('What are the tradeoffs?', {
    kind: 'tradeoff_probe',
    confidence: 0.9,
    cues: ['tradeoff_language'],
    targetFacets: ['tradeoffs'],
    shouldContinueThread: true,
  });

  const hypothesis = store.getLatestHypothesis();
  assert.ok(hypothesis);
  assert.equal(hypothesis?.reactionKind, 'tradeoff_probe');
  assert.ok((hypothesis?.confidence ?? 0) > 0.7);
  assert.ok(hypothesis?.evidence.includes('suggested'));
  assert.ok(hypothesis?.evidence.includes('inferred'));
  assert.ok(store.buildContextBlock().includes('INTERVIEWER_REACTION: tradeoff_probe'));
  assert.ok(store.buildContextBlock().includes('LIKELY_THEMES:'));
});
