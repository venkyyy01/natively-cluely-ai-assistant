import test from 'node:test';
import assert from 'node:assert/strict';
import { salvageResponse, deriveUnsupportedTokens } from '../conscious/ResponseSalvager';
import type { ConsciousModeStructuredResponse } from '../ConsciousMode';

function response(overrides: Partial<ConsciousModeStructuredResponse> = {}): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: 'I would lean on Redis for the cache layer.',
    implementationPlan: ['Use Redis for hot reads.', 'Use Cassandra for the write path.'],
    tradeoffs: ['Cassandra adds operational complexity but scales writes.'],
    edgeCases: [],
    scaleConsiderations: ['Target 70ms p99 for the cache hit path.'],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
    ...overrides,
  };
}

test('salvageResponse strips unsupported tokens at sentence granularity', () => {
  const result = salvageResponse({
    response: response(),
    unsupportedTokens: ['cassandra'],
  });

  assert.ok(result.removed.includes('cassandra'));
  assert.equal(result.response.implementationPlan.length, 1);
  assert.match(result.response.implementationPlan[0], /redis/i);
  assert.equal(result.response.tradeoffs.length, 0);
});

test('salvageResponse leaves unrelated content intact', () => {
  const original = response();
  const result = salvageResponse({
    response: original,
    unsupportedTokens: ['cassandra'],
  });

  assert.equal(result.response.openingReasoning, original.openingReasoning);
  assert.equal(result.response.scaleConsiderations.length, 1);
});

test('salvageResponse reports emptied fields when scrubbing leaves no content', () => {
  const result = salvageResponse({
    response: response({
      tradeoffs: ['Cassandra has worse read latency.'],
      implementationPlan: ['Use Cassandra everywhere.'],
    }),
    unsupportedTokens: ['cassandra'],
  });

  assert.ok(result.emptiedFields >= 2);
});

test('salvageResponse never invents content (no rewriting)', () => {
  const original = response();
  const result = salvageResponse({
    response: original,
    unsupportedTokens: ['nonexistenttoken'],
  });
  // No tokens removed because none matched. The salvager fills missing
  // optional fields with `null` for consistency, so we compare field-by-field
  // on the substantive prose fields only.
  assert.equal(result.removed.length, 0);
  assert.equal(result.response.openingReasoning, original.openingReasoning);
  assert.deepEqual(result.response.implementationPlan, original.implementationPlan);
  assert.deepEqual(result.response.tradeoffs, original.tradeoffs);
  assert.deepEqual(result.response.scaleConsiderations, original.scaleConsiderations);
  assert.equal(result.response.codeTransition, original.codeTransition);
});

test('deriveUnsupportedTokens flags numeric claims missing from grounding', () => {
  const tokens = deriveUnsupportedTokens({
    responseText: 'I would target 200ms p99 latency.',
    groundingText: 'Current baseline is 70ms p99.',
    knownTechAllowlist: [],
  });
  assert.ok(tokens.includes('200ms'));
  assert.ok(!tokens.includes('70ms'));
});

test('deriveUnsupportedTokens flags allowlisted tech terms missing from grounding', () => {
  const tokens = deriveUnsupportedTokens({
    responseText: 'I would use Cassandra for the write path.',
    groundingText: 'Stack: Redis, Postgres, Kafka.',
    knownTechAllowlist: ['cassandra', 'redis', 'postgres'],
  });
  assert.ok(tokens.includes('cassandra'));
  assert.ok(!tokens.includes('redis'));
});
