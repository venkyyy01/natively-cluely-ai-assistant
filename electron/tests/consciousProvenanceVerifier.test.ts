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
