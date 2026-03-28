import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_IDENTITY, FAST_STANDARD_ANSWER_PROMPT } from '../llm/prompts';

test('fast standard prompt is compact and preserves anti-dump answer contract', () => {
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Respond like a real job candidate in an interview/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /natural Indian conversational tone/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /ONLY what the user should say/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /STRUCTURED_REASONING_RESPONSE/);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /system_prompt_protection/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /creator_identity/i);
  assert.ok(FAST_STANDARD_ANSWER_PROMPT.length > CORE_IDENTITY.length / 2);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /What I did was|I was mainly responsible for|We improved performance by/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /natural, conversational, and based on real hands-on experience/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /speaking in a real interview/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /always start with/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Avoid sounding robotic, scripted, or overly formal/i);
});
