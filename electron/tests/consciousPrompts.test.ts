import test from 'node:test';
import assert from 'node:assert/strict';
import * as prompts from '../llm/prompts';

test('Conscious Mode prompt family exports dedicated prompt variants from source', () => {
  assert.ok('CONSCIOUS_MODE_PROMPT_FAMILY' in prompts);

  const family = (prompts as Record<string, unknown>).CONSCIOUS_MODE_PROMPT_FAMILY as Record<string, string>;

  assert.equal(typeof family.openingReasoning, 'string');
  assert.equal(typeof family.implementationPath, 'string');
  assert.equal(typeof family.pushbackHandling, 'string');
  assert.equal(typeof family.followUpContinuation, 'string');
});

test('Conscious Mode opening reasoning prompt prioritizes understanding and natural speech over code dumps', () => {
  const family = (prompts as Record<string, unknown>).CONSCIOUS_MODE_PROMPT_FAMILY as Record<string, string>;

  // Must emphasize understanding before answering
  assert.match(family.openingReasoning, /understand|EXACTLY what.*ask/i);
  // Must have anti-dump guidance
  assert.match(family.openingReasoning, /dump|wall.*text|paragraph/i);
  // Must emphasize natural/spoken response
  assert.match(family.openingReasoning, /spoken|natural|human/i);
});

test('Conscious Mode prompt family includes core response contract fields', () => {
  const family = (prompts as Record<string, unknown>).CONSCIOUS_MODE_PROMPT_FAMILY as Record<string, string>;
  const combined = [
    family.openingReasoning,
    family.implementationPath,
    family.pushbackHandling,
    family.followUpContinuation,
  ].join('\n');

  // Core fields that should exist in new anti-dump contract
  for (const key of [
    'openingReasoning',
    'spokenResponse',
    'tradeoffs',
    'likelyFollowUps',
  ]) {
    assert.match(combined, new RegExp(key));
  }
});

test('Conscious Mode prompt family prioritizes system design flow before code', () => {
  const family = (prompts as Record<string, unknown>).CONSCIOUS_MODE_PROMPT_FAMILY as Record<string, string>;
  const combined = [
    family.openingReasoning,
    family.implementationPath,
    family.followUpContinuation,
  ].join('\n');

  assert.match(combined, /requirements|constraints|clarify/i);
  assert.match(combined, /architecture|components|high-level/i);
  assert.match(combined, /tradeoffs|bottlenecks/i);
  assert.match(combined, /scale|reliability|failover/i);
  assert.match(combined, /before code|before coding|before implementation details/i);
});
