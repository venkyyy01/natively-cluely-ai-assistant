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

test('Conscious Mode opening reasoning prompt prioritizes spoken reasoning over code-first answers', () => {
  const family = (prompts as Record<string, unknown>).CONSCIOUS_MODE_PROMPT_FAMILY as Record<string, string>;

  assert.match(family.openingReasoning, /spoken reasoning/i);
  assert.match(family.openingReasoning, /do not jump straight to code|avoid code-first/i);
  assert.match(family.openingReasoning, /natural enough to say in an interview|natural spoken/i);
});

test('Conscious Mode prompt family aligns with the structured reasoning response contract', () => {
  const family = (prompts as Record<string, unknown>).CONSCIOUS_MODE_PROMPT_FAMILY as Record<string, string>;
  const combined = [
    family.openingReasoning,
    family.implementationPath,
    family.pushbackHandling,
    family.followUpContinuation,
  ].join('\n');

  for (const key of [
    'openingReasoning',
    'implementationPlan',
    'tradeoffs',
    'edgeCases',
    'scaleConsiderations',
    'pushbackResponses',
    'likelyFollowUps',
    'codeTransition',
  ]) {
    assert.match(combined, new RegExp(key));
  }
});
