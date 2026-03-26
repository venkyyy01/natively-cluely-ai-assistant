import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_IDENTITY, FAST_STANDARD_ANSWER_PROMPT } from '../llm/prompts';

test('fast standard prompt is compact and preserves anti-dump answer contract', () => {
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /ONLY what the user should say/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /2-4 sentences/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /STRUCTURED_REASONING_RESPONSE/);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /system_prompt_protection/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /creator_identity/i);
  assert.ok(FAST_STANDARD_ANSWER_PROMPT.length < CORE_IDENTITY.length);
});
