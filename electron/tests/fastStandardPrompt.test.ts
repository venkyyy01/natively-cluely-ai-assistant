import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_IDENTITY,
  UNIVERSAL_ANSWER_PROMPT,
  FAST_STANDARD_ANSWER_PROMPT,
  UNIVERSAL_WHAT_TO_ANSWER_PROMPT,
} from '../llm/prompts';

test('fast standard prompt is compact and preserves the standard-mode answer contract', () => {
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Respond like a real job candidate in an interview/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /natural Indian English conversational tone/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /ONLY what the user should say/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /STRUCTURED_REASONING_RESPONSE/);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /system_prompt_protection/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /creator_identity/i);
  assert.ok(FAST_STANDARD_ANSWER_PROMPT.length > CORE_IDENTITY.length / 2);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Never invent experience, projects, metrics, ownership, or outcomes/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /direct experience is limited/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /actual candidate speaking directly/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /speaking in a real interview/i);
  assert.doesNotMatch(FAST_STANDARD_ANSWER_PROMPT, /always start with/i);
  assert.match(FAST_STANDARD_ANSWER_PROMPT, /Avoid sounding robotic, scripted, or overly formal/i);
});

test('standard-mode prompts require honest experience claims and defensible ambiguity handling', () => {
  for (const prompt of [FAST_STANDARD_ANSWER_PROMPT, UNIVERSAL_WHAT_TO_ANSWER_PROMPT]) {
    assert.match(prompt, /Indian English conversational tone/i);
    assert.match(prompt, /actual candidate speaking directly|actual person speaking directly/i);
    assert.match(prompt, /never invent experience|do not invent experience/i);
    assert.match(prompt, /direct experience is limited|only claim direct hands-on experience/i);
    assert.match(prompt, /ask one brief clarifying question|ask one clarifying question/i);
    assert.match(prompt, /easy to defend under follow-up|strong follow-up/i);
  }
});

test('universal standard prompts avoid contradictory first-person and coding rules', () => {
  assert.doesNotMatch(UNIVERSAL_ANSWER_PROMPT, /no pronouns/i);
  assert.doesNotMatch(UNIVERSAL_WHAT_TO_ANSWER_PROMPT, /Always provide code if programming-related/i);
  assert.match(UNIVERSAL_WHAT_TO_ANSWER_PROMPT, /clearly wants implementation|otherwise start with approach/i);
});
