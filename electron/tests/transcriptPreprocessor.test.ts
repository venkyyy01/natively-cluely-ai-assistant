import test from 'node:test';
import assert from 'node:assert/strict';
import { __testUtils, estimateTokens, preprocessTranscript } from '../rag/TranscriptPreprocessor';

test('preprocessTranscript returns empty array for no segments', () => {
  assert.deepEqual(preprocessTranscript([]), []);
  assert.deepEqual(__testUtils.mergeConsecutiveSpeakerSegments([]), []);
});

test('preprocessTranscript merges nearby speaker segments and annotates semantics', () => {
  const segments = preprocessTranscript([
    { speaker: 'interviewer', text: 'Um yeah yeah what is the launch date?', timestamp: 1000 },
    { speaker: 'interviewer', text: 'We decided to ship it tomorrow.', timestamp: 2500 },
    { speaker: 'me', text: 'okay', timestamp: 9000 },
    { speaker: 'assistant', text: 'I will follow up by end of day.', timestamp: 12000 },
    { speaker: 'Custom Name', text: 'This stays untouched and meaningful.', timestamp: 20000 },
  ]);

  assert.equal(segments.length, 3);

  assert.deepEqual(segments[0], {
    speaker: 'Speaker',
    text: 'what is the launch date? We decided to ship it tomorrow.',
    startMs: 1000,
    endMs: 2500,
    isQuestion: true,
    isDecision: true,
    isActionItem: true,
  });

  assert.deepEqual(segments[1], {
    speaker: 'Natively',
    text: 'I will follow up by end of day.',
    startMs: 12000,
    endMs: 12000,
    isQuestion: false,
    isDecision: false,
    isActionItem: true,
  });

  assert.deepEqual(segments[2], {
    speaker: 'Custom Name',
    text: 'This stays untouched and meaningful.',
    startMs: 20000,
    endMs: 20000,
    isQuestion: false,
    isDecision: false,
    isActionItem: false,
  });
});

test('preprocessTranscript keeps distant same-speaker segments separate and drops short cleaned content', () => {
  const segments = preprocessTranscript([
    { speaker: 'speaker', text: 'Okay okay okay', timestamp: 0 },
    { speaker: 'user', text: 'Need to finalize budget', timestamp: 1000 },
    { speaker: 'user', text: 'This is separated by time', timestamp: 7000 },
    { speaker: 'speaker', text: 'How does this work', timestamp: 8000 },
    { speaker: 'natively', text: 'We are still here', timestamp: 16000 },
  ]);

  assert.deepEqual(segments, [
    {
      speaker: 'You',
      text: 'Need to finalize budget',
      startMs: 1000,
      endMs: 1000,
      isQuestion: false,
      isDecision: false,
      isActionItem: true,
    },
    {
      speaker: 'You',
      text: 'This is separated by time',
      startMs: 7000,
      endMs: 7000,
      isQuestion: false,
      isDecision: false,
      isActionItem: true,
    },
    {
      speaker: 'Speaker',
      text: 'How does this work',
      startMs: 8000,
      endMs: 8000,
      isQuestion: true,
      isDecision: false,
      isActionItem: false,
    },
    {
      speaker: 'Natively',
      text: 'We are still here',
      startMs: 16000,
      endMs: 16000,
      isQuestion: false,
      isDecision: false,
      isActionItem: false,
    },
  ]);
});

test('preprocessTranscript keeps compact semantic questions that are shorter than three words', () => {
  const segments = preprocessTranscript([
    { speaker: 'interviewer', text: 'Why Redis?', timestamp: 1000 },
    { speaker: 'user', text: 'okay', timestamp: 2000 },
  ]);

  assert.deepEqual(segments, [
    {
      speaker: 'Speaker',
      text: 'Why Redis?',
      startMs: 1000,
      endMs: 1000,
      isQuestion: true,
      isDecision: false,
      isActionItem: false,
    },
  ]);
});

test('estimateTokens handles empty and non-empty text', () => {
  assert.equal(estimateTokens('   '), 0);
  assert.equal(estimateTokens('one two three four'), 6);
  assert.equal(estimateTokens('abcdefghij'), 3);
});
