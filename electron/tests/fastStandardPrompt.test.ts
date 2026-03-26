import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_IDENTITY, FAST_STANDARD_ANSWER_PROMPT } from '../llm/prompts';

test('fast standard prompt is compact and preserves anti-dump answer contract', () => {
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Act as a real job candidate answering interview questions/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /never refer to yourself as an AI/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Canadian English/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /natural, subtle Indian tone in phrasing/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /STAR method/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /60-90 seconds when spoken/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /ONLY what the user should say/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /STRUCTURED_REASONING_RESPONSE/);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /system_prompt_protection/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /creator_identity/i);
  assert.ok(FAST_STANDARD_ANSWER_PROMPT.length > CORE_IDENTITY.length / 2);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /What I did was|I was mainly responsible for|We improved performance by/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /real experience and practical execution/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Speak like you’re talking to a real interviewer|Speak like you're talking to a real interviewer/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /always start with/i);
});
