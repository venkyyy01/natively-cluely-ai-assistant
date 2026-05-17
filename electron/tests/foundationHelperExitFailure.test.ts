import test from 'node:test';
import assert from 'node:assert/strict';

import { mapExitFailure } from '../llm/providers/FoundationModelsIntentProvider';

test('NAT-052: structured JSON stderr is preferred over substring matching', () => {
  const result = mapExitFailure('{"kind":"rate_limited","retryAfterMs":500}');
  assert.equal(result, 'rate_limited');
});

test('NAT-052: structured JSON with errorType field works', () => {
  const result = mapExitFailure('{"errorType":"model_not_ready"}');
  assert.equal(result, 'model_not_ready');
});

test('NAT-052: unknown structured kind falls back to unknown', () => {
  const result = mapExitFailure('{"kind":"weird_error"}');
  assert.equal(result, 'unknown');
});

test('NAT-052: substring fallback still works for non-JSON stderr', () => {
  assert.equal(mapExitFailure('model not ready'), 'model_not_ready');
  assert.equal(mapExitFailure('timeout error'), 'timeout');
  assert.equal(mapExitFailure('service unavailable'), 'unavailable');
  assert.equal(mapExitFailure('refusal from model'), 'refusal');
});

test('NAT-052: rate limit substring matches without JSON', () => {
  assert.equal(mapExitFailure('rate limit exceeded'), 'rate_limited');
});

test('NAT-052: empty stderr returns unknown', () => {
  assert.equal(mapExitFailure(''), 'unknown');
});

test('NAT-052: malformed JSON falls through to substring matching', () => {
  assert.equal(mapExitFailure('{invalid json'), 'unknown');
});
