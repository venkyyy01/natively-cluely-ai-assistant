import test from 'node:test';
import assert from 'node:assert/strict';
import { DesignStateStore } from '../conscious';

test('DesignStateStore captures requirements, architecture, and open questions from live turns', () => {
  const store = new DesignStateStore();
  const now = Date.now();

  store.noteInterviewerTurn({
    transcript: 'We have a $300k budget, 6 engineers, and a 99.9% availability target. How would you design the API gateway?',
    timestamp: now,
    phase: 'requirements_gathering',
    constraints: [
      { type: 'budget', raw: '$300k budget', normalized: '$300k budget' },
      { type: 'percentage', raw: '99.9%', normalized: '99.9%' },
    ],
  });

  const block = store.buildContextBlock('How do you scale the API gateway under burst traffic?');

  assert.match(block, /CURRENT_OBJECTIVE:/);
  assert.match(block, /REQUIREMENTS:/);
  assert.match(block, /ARCHITECTURE_DECISIONS:/);
  assert.match(block, /OPEN_QUESTIONS:/);
});

test('DesignStateStore captures structured reasoning facets and restores from persistence', () => {
  const store = new DesignStateStore();
  const now = Date.now();

  store.noteStructuredResponse({
    question: 'How would you design a billing ledger?',
    timestamp: now,
    phase: 'high_level_design',
    response: {
      mode: 'reasoning_first',
      openingReasoning: 'I would separate the write path from the read path.',
      implementationPlan: [
        'Expose an idempotent write API for ledger mutations',
        'Use an append-only ledger table with secondary indexes for account lookups',
      ],
      tradeoffs: ['Strict consistency increases write latency'],
      edgeCases: ['Duplicate payment webhooks must stay idempotent'],
      scaleConsiderations: ['Shard by account for hot enterprise tenants'],
      pushbackResponses: ['I optimize for correctness over cheap writes.'],
      likelyFollowUps: [],
      codeTransition: '',
    },
  });

  const snapshot = store.getPersistenceSnapshot();
  const restored = new DesignStateStore();
  restored.restorePersistenceSnapshot(snapshot);

  const block = restored.buildContextBlock('What failure modes and tradeoffs matter most in the ledger?');

  assert.match(block, /API_CONTRACTS:/);
  assert.match(block, /DATA_MODEL:/);
  assert.match(block, /TRADEOFFS:/);
  assert.match(block, /FAILURE_MODES:/);
  assert.match(block, /SCALING_PLAN:/);
});
