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

test('Conscious Mode prompts restrict fresh starts to system design and screenshot-backed live coding continuations', () => {
  const family = (prompts as Record<string, unknown>).CONSCIOUS_MODE_PROMPT_FAMILY as Record<string, string>;
  const combined = [
    family.openingReasoning,
    family.implementationPath,
    family.followUpContinuation,
  ].join('\n');

  assert.match(combined, /system design/i);
  assert.match(combined, /screenshot/i);
  assert.match(combined, /continuation|continue an existing reasoning thread/i);
  assert.doesNotMatch(combined, /all technical questions can use conscious mode/i);
});

test('Conscious reasoning system prompt enforces JSON output and never asks for spoken-only output', () => {
  assert.ok('CONSCIOUS_REASONING_SYSTEM_PROMPT' in prompts);
  const prompt = (prompts as Record<string, unknown>).CONSCIOUS_REASONING_SYSTEM_PROMPT as string;

  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /return only valid json/i);
  assert.match(prompt, /"mode":\s*"reasoning_first"/i);
  assert.doesNotMatch(prompt, /output only the spoken answer/i);
});
