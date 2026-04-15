import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsciousProvenanceVerifier } from '../conscious/ConsciousProvenanceVerifier';
import type { ConsciousModeStructuredResponse } from '../ConsciousMode';

function response(overrides: Partial<ConsciousModeStructuredResponse> = {}): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: 'I would use Redis and Kafka for the core path.',
    implementationPlan: ['Use Redis for caching', 'Use Kafka for the async fan-out'],
    tradeoffs: [],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
    ...overrides,
  };
}

test('ConsciousProvenanceVerifier rejects unsupported technology claims', () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = verifier.verify({
    response: response({ openingReasoning: 'I would use Cassandra for the core path.', implementationPlan: ['Use Cassandra for the write path'] }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka\n</conscious_semantic_memory>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported_technology_claim');
});

test('ConsciousProvenanceVerifier rejects unsupported metric claims', () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = verifier.verify({
    response: response({
      openingReasoning: 'I would keep the current architecture and measure carefully.',
      implementationPlan: [],
      scaleConsiderations: ['I would target 10ms p99 latency immediately'],
    }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka. Reduced p99 latency to 70ms.\n</conscious_semantic_memory>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported_metric_claim');
});

test('ConsciousProvenanceVerifier accepts grounded technology and metric content', () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = verifier.verify({
    response: response({ scaleConsiderations: ['I would watch the existing 70ms p99 baseline first'] }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka. Reduced p99 latency to 70ms.\n</conscious_semantic_memory>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('ConsciousProvenanceVerifier accepts technology claims grounded by the current question', () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = verifier.verify({
    response: response(),
    question: 'How would you use Redis and Kafka in this design?',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('ConsciousProvenanceVerifier does not reject open-ended technical answers without grounding context', () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = verifier.verify({
    response: response({ openingReasoning: 'I would use Cassandra for the core path.', implementationPlan: ['Use Cassandra for the write path'] }),
    question: 'How would you use Redis for the cache layer?',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('ConsciousProvenanceVerifier accepts metric claims grounded by evidence context', () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = verifier.verify({
    response: response({
      openingReasoning: 'I would keep the current architecture and measure carefully.',
      implementationPlan: [],
      scaleConsiderations: ['I would watch the existing 70ms p99 baseline first'],
    }),
    evidenceContextBlock: '<conscious_evidence>\nLATEST_SUGGESTED_ANSWER: Current baseline is 70ms p99 latency.\n</conscious_evidence>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('ConsciousProvenanceVerifier does not treat hypothesis text as grounding context', () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = verifier.verify({
    response: response({ openingReasoning: 'I would use Cassandra for the core path.', implementationPlan: ['Use Cassandra for the write path'] }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka\n</conscious_semantic_memory>',
    hypothesis: {
      sourceQuestion: 'How would you design this?',
      latestSuggestedAnswer: 'Use Cassandra for the write path.',
      likelyThemes: ['cassandra'],
      confidence: 0.88,
      evidence: ['suggested'],
      targetFacets: [],
      updatedAt: Date.now(),
    },
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported_technology_claim');
});
