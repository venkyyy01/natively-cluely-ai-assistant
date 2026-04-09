import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionReactionClassifier } from '../conscious/QuestionReactionClassifier';
import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';

function createResponse(): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: 'I would use Redis-backed token buckets.',
    implementationPlan: ['Use Redis for distributed counters'],
    tradeoffs: ['Adds network hop latency'],
    edgeCases: ['Hot keys can appear under bursty traffic'],
    scaleConsiderations: ['Track QPS and hot-key skew'],
    pushbackResponses: ['Redis gives us coordination across instances.'],
    likelyFollowUps: [],
    codeTransition: '',
  };
}

function createThread(): ReasoningThread {
  return {
    rootQuestion: 'How would you design a rate limiter?',
    lastQuestion: 'How would you design a rate limiter?',
    response: createResponse(),
    followUpCount: 0,
    updatedAt: Date.now(),
  };
}

test('QuestionReactionClassifier detects tradeoff probes on an active thread', () => {
  const classifier = new QuestionReactionClassifier();
  const reaction = classifier.classify({
    question: 'What are the tradeoffs here?',
    activeThread: createThread(),
    latestResponse: createResponse(),
  });

  assert.equal(reaction.kind, 'tradeoff_probe');
  assert.equal(reaction.shouldContinueThread, true);
  assert.deepEqual(reaction.targetFacets, ['tradeoffs']);
});

test('QuestionReactionClassifier treats explicit topic shifts as thread resets', () => {
  const classifier = new QuestionReactionClassifier();
  const reaction = classifier.classify({
    question: 'Let us switch gears and talk about the launch plan.',
    activeThread: createThread(),
    latestResponse: createResponse(),
  });

  assert.equal(reaction.kind, 'topic_shift');
  assert.equal(reaction.shouldContinueThread, false);
});
