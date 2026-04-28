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

test('ConsciousProvenanceVerifier rejects unsupported technology claims', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({ openingReasoning: 'I would use Cassandra for the core path.', implementationPlan: ['Use Cassandra for the write path'] }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka\n</conscious_semantic_memory>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported_technology_claim');
});

test('ConsciousProvenanceVerifier rejects unsupported metric claims', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
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

test('ConsciousProvenanceVerifier accepts grounded technology and metric content', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({ scaleConsiderations: ['I would watch the existing 70ms p99 baseline first'] }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka. Reduced p99 latency to 70ms.\n</conscious_semantic_memory>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('ConsciousProvenanceVerifier rejects unsupported dynamic technology claims', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({
      openingReasoning: 'I would use Pinecone for the vector index and SQS for fan-out.',
      implementationPlan: ['Store embeddings in Pinecone', 'Push async work through SQS'],
    }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka\n</conscious_semantic_memory>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported_technology_claim');
});

test('ConsciousProvenanceVerifier accepts dynamic technology claims grounded by evidence or question context', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({
      openingReasoning: 'I would use Pinecone for the vector index and SQS for fan-out.',
      implementationPlan: ['Store embeddings in Pinecone', 'Push async work through SQS'],
    }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Search Platform: Technologies: Pinecone, SQS\n</conscious_semantic_memory>',
    question: 'How would Pinecone fit into the retrieval path?',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('NAT-004 / audit A-9: question text is NOT treated as grounding for technology claims', async () => {
  // The verifier previously accepted this because `relaxed = strict + question`
  // included the question's "Redis"/"Kafka" terms. Echoing the question is not
  // evidence — the response must be backed by semantic or evidence context.
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response(),
    semanticContextBlock: '<conscious_semantic_memory>Grounding enabled.</conscious_semantic_memory>',
    question: 'How would you use Redis and Kafka in this design?',
    hypothesis: null,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported_technology_claim');
});

test('NAT-004 / audit A-4: empty grounding + technology claim passes through (unverifiable, not rejected)', async () => {
  // When no profile/semantic data is loaded, technology claims cannot be
  // verified against grounding context. Rather than failing closed (which
  // trips the circuit breaker), we pass through with a log note.
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({ openingReasoning: 'I would use Cassandra for the core path.', implementationPlan: ['Use Cassandra for the write path'] }),
    question: 'How would you use Redis for the cache layer?',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('NAT-004 / audit A-4: empty grounding + no verifiable claim still passes', async () => {
  // Open-ended reasoning that doesn't name a specific technology or quote a
  // metric is still allowed when there is no grounding context. We only fail
  // closed when the response makes a claim the verifier cannot verify.
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({
      openingReasoning: 'I would scope the requirements first and confirm priorities with the team.',
      implementationPlan: ['Confirm acceptance criteria', 'Sketch a minimal happy-path flow'],
      tradeoffs: [],
      edgeCases: [],
      scaleConsiderations: [],
    }),
    question: 'How would you approach this open-ended design?',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});

test('ConsciousProvenanceVerifier accepts metric claims grounded by evidence context', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
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

test('ConsciousProvenanceVerifier does not treat hypothesis text as grounding context', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
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

test('ConsciousProvenanceVerifier rejects unsupported lowercase dynamic technology claims', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({
      openingReasoning: 'I would use weaviate for the vector index.',
      implementationPlan: ['Store embeddings in weaviate'],
    }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Tenant Analytics Platform: Technologies: Redis, Kafka\n</conscious_semantic_memory>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported_technology_claim');
});

test('ConsciousProvenanceVerifier accepts lowercase dynamic technology claims grounded by profile or evidence context', async () => {
  const verifier = new ConsciousProvenanceVerifier();
  const verdict = await verifier.verify({
    response: response({
      openingReasoning: 'I would use weaviate for the vector index.',
      implementationPlan: ['Store embeddings in weaviate'],
    }),
    semanticContextBlock: '<conscious_semantic_memory>\n[PROJECT] Search Platform: Technologies: weaviate, kafka\n</conscious_semantic_memory>',
    evidenceContextBlock: '<conscious_evidence>\nLATEST_SUGGESTED_ANSWER: weaviate is already part of the retrieval stack.\n</conscious_evidence>',
    hypothesis: null,
  });

  assert.equal(verdict.ok, true);
});
