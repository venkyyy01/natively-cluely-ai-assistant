import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousVerifier } from '../conscious/ConsciousVerifier';
import { ConsciousVerifierLLM } from '../conscious/ConsciousVerifierLLM';
import type { ConsciousModeStructuredResponse } from '../ConsciousMode';

function response(overrides: Partial<ConsciousModeStructuredResponse> = {}): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: 'I would start with tenant partitioning.',
    implementationPlan: ['Partition by tenant'],
    tradeoffs: [],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
    ...overrides,
  };
}

test('ConsciousVerifier rejects tradeoff probes with no tradeoff or defense content', async () => {
  const verifier = new ConsciousVerifier();
  const result = await verifier.verify({
    response: response(),
    route: { qualifies: true, threadAction: 'continue' },
    reaction: {
      kind: 'tradeoff_probe',
      confidence: 0.9,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    },
    hypothesis: null,
    question: 'What are the tradeoffs?',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_tradeoff_content');
});

test('ConsciousVerifier rejects duplicate continuation answers', async () => {
  const verifier = new ConsciousVerifier();
  const result = await verifier.verify({
    response: response({ openingReasoning: 'same answer', implementationPlan: [] }),
    route: { qualifies: true, threadAction: 'continue' },
    reaction: {
      kind: 'generic_follow_up',
      confidence: 0.6,
      cues: ['active_thread_follow_up'],
      targetFacets: [],
      shouldContinueThread: true,
    },
    hypothesis: {
      sourceQuestion: 'Why this approach?',
      latestSuggestedAnswer: 'same answer',
      likelyThemes: ['same answer'],
      confidence: 0.8,
      evidence: ['suggested'],
      targetFacets: [],
      updatedAt: Date.now(),
    },
    question: 'Why this approach?',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate_follow_up_response');
});

test('ConsciousVerifier rejects behavioral questions without explicit STAR structure', async () => {
  const verifier = new ConsciousVerifier();
  const result = await verifier.verify({
    response: response({
      openingReasoning: 'I handled a conflict by talking to the team and fixing the release issue.',
      implementationPlan: [],
    }),
    route: { qualifies: true, threadAction: 'start' },
    reaction: null,
    hypothesis: null,
    question: 'Tell me about a time you handled team conflict during a release.',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_behavioral_star_structure');
});

test('ConsciousVerifier accepts a tradeoff probe when tradeoffs are present', async () => {
  const verifier = new ConsciousVerifier();
  const result = await verifier.verify({
    response: response({ tradeoffs: ['Cross-tenant reads get more expensive'] }),
    route: { qualifies: true, threadAction: 'continue' },
    reaction: {
      kind: 'tradeoff_probe',
      confidence: 0.9,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    },
    hypothesis: null,
    question: 'What are the tradeoffs?',
  });

  assert.equal(result.ok, true);
});

test('ConsciousVerifier falls back to rule-based acceptance when LLM judge is unavailable', async () => {
  const verifier = new ConsciousVerifier(new ConsciousVerifierLLM({
    generateContentStructured: async () => '{"ok": false, "reason": "should_not_run"}',
    hasStructuredGenerationCapability: () => false,
  }));

  const result = await verifier.verify({
    response: response({ tradeoffs: ['Cross-tenant reads get more expensive'] }),
    route: { qualifies: true, threadAction: 'continue' },
    reaction: {
      kind: 'tradeoff_probe',
      confidence: 0.9,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    },
    hypothesis: null,
    question: 'What are the tradeoffs?',
  });

  assert.equal(result.ok, true);
});

test('ConsciousVerifier rejects in strict mode when the LLM judge is unavailable', async () => {
  const verifier = new ConsciousVerifier(new ConsciousVerifierLLM({
    generateContentStructured: async () => '{"ok": false, "reason": "should_not_run"}',
    hasStructuredGenerationCapability: () => false,
  }), { requireJudge: true });

  const result = await verifier.verify({
    response: response({ tradeoffs: ['Cross-tenant reads get more expensive'] }),
    route: { qualifies: true, threadAction: 'continue' },
    reaction: {
      kind: 'tradeoff_probe',
      confidence: 0.9,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    },
    hypothesis: null,
    question: 'What are the tradeoffs?',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'judge_unavailable');
});

test('ConsciousVerifier honors an LLM judge rejection when rules pass', async () => {
  const verifier = new ConsciousVerifier(new ConsciousVerifierLLM({
    generateContentStructured: async () => '{"ok": false, "reason": "llm_detected_misalignment", "confidence": 0.91}',
    hasStructuredGenerationCapability: () => true,
  }, 50));

  const result = await verifier.verify({
    response: response({ tradeoffs: ['Cross-tenant reads get more expensive'] }),
    route: { qualifies: true, threadAction: 'continue' },
    reaction: {
      kind: 'tradeoff_probe',
      confidence: 0.9,
      cues: ['tradeoff_language'],
      targetFacets: ['tradeoffs'],
      shouldContinueThread: true,
    },
    hypothesis: null,
    question: 'What are the tradeoffs?',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'llm_detected_misalignment');
});
