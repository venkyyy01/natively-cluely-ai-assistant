import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCREENSHOT_FRESHNESS_MS,
  isBehavioralQuestion,
  isCodingShapedQuestion,
  shouldAutoAttachScreenshotsForQuestion,
} from '../coding/screenshotRelevance';

test('NAT-SCREENSHOT-RELEVANCE: coding-shape gate matches typical live coding asks', () => {
  const codingQuestions = [
    'Can you write a function to find the longest substring without repeating characters?',
    'Why is this failing on the third test case?',
    "What's wrong with this implementation?",
    'Solve this leetcode problem',
    'Look at this screenshot and tell me what the bug is',
    'Implement a debounce function in TypeScript',
    'Refactor the SQL query for better complexity',
    'Debug the code on screen',
    'How would you fix this coding problem?',
    'Approach this and explain the optimal algorithm.',
  ];
  for (const q of codingQuestions) {
    assert.equal(isCodingShapedQuestion(q), true, `expected coding-shape for: ${q}`);
    assert.equal(shouldAutoAttachScreenshotsForQuestion(q), true, `expected attach for: ${q}`);
  }
});

test('NAT-SCREENSHOT-RELEVANCE: behavioral questions are not coding-shaped', () => {
  const behavioralQuestions = [
    'Tell me about a time you led a difficult project.',
    'Describe a situation where you had a conflict with a teammate.',
    'Walk me through your leadership style.',
    'Give me an example of a failure and what you learned.',
    'How do you handle disagreement with a senior stakeholder?',
    'Talk about a project you owned end to end.',
    'Tell me about feedback you found hard to receive.',
    'Describe a time you mentored a junior engineer.',
  ];
  for (const q of behavioralQuestions) {
    assert.equal(isBehavioralQuestion(q), true, `expected behavioral for: ${q}`);
    assert.equal(shouldAutoAttachScreenshotsForQuestion(q), false, `expected NO attach for: ${q}`);
  }
});

test('NAT-SCREENSHOT-RELEVANCE: behavioral signal beats accidental coding cue', () => {
  // Mixed-signal: contains coding cue ("function"/"code"/"error") *and*
  // a behavioral framing. Behavioral wins because attaching a screenshot
  // to "tell me about a time" is the costlier mistake.
  const mixed = [
    'Tell me about a time when you had to debug a critical error in production.',
    'Walk me through a project where you had to refactor messy code.',
    'Describe a conflict with a teammate over a function design.',
  ];
  for (const q of mixed) {
    assert.equal(isCodingShapedQuestion(q), true, `coding cue present in: ${q}`);
    assert.equal(isBehavioralQuestion(q), true, `behavioral framing present in: ${q}`);
    assert.equal(shouldAutoAttachScreenshotsForQuestion(q), false, `behavioral must win for: ${q}`);
  }
});

test('NAT-SCREENSHOT-RELEVANCE: empty / null / non-coding small-talk does not auto-attach', () => {
  const nonCoding = [
    null,
    undefined,
    '',
    '   ',
    'Hello, how are you today?',
    'Can you hear me clearly?',
    'Just give me a second to pull this up.',
  ];
  for (const q of nonCoding) {
    assert.equal(shouldAutoAttachScreenshotsForQuestion(q), false, `no attach for: ${JSON.stringify(q)}`);
  }
});

test('NAT-SCREENSHOT-RELEVANCE: default freshness window is positive and bounded', () => {
  // Sanity: window must be reasonable. Too small (<5s) and the
  // "screenshot then ask" flow breaks; too large (>5min) and stale
  // screenshots leak across topics.
  assert.equal(typeof DEFAULT_SCREENSHOT_FRESHNESS_MS, 'number');
  assert.ok(DEFAULT_SCREENSHOT_FRESHNESS_MS >= 5_000, 'freshness window too small');
  assert.ok(DEFAULT_SCREENSHOT_FRESHNESS_MS <= 5 * 60_000, 'freshness window too large');
});
