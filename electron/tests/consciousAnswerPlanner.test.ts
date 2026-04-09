import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousAnswerPlanner } from '../conscious/ConsciousAnswerPlanner';

test('ConsciousAnswerPlanner selects tradeoff_defense for tradeoff probes', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'What are the tradeoffs?',
    reaction: {
      kind: 'tradeoff_probe',
      confidence: 0.91,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    },
    hypothesis: null,
  });

  assert.equal(plan.answerShape, 'tradeoff_defense');
  assert.deepEqual(plan.focalFacets, ['tradeoffs']);
  assert.ok(planner.buildContextBlock(plan).includes('ANSWER_SHAPE: tradeoff_defense'));
});

test('ConsciousAnswerPlanner selects metric_backed_answer for metric probes', () => {
  const planner = new ConsciousAnswerPlanner();
  const plan = planner.plan({
    question: 'What metrics would you watch?',
    reaction: {
      kind: 'metric_probe',
      confidence: 0.88,
      cues: ['metric_language'],
      targetFacets: ['scaleConsiderations'],
      shouldContinueThread: true,
    },
    hypothesis: null,
  });

  assert.equal(plan.answerShape, 'metric_backed_answer');
});
