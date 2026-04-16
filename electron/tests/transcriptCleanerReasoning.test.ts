import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTranscriptForReasoning, prepareTranscriptForWhatToAnswer } from '../llm/transcriptCleaner';

test('prepareTranscriptForReasoning preserves technical identifiers and casing', () => {
  const now = Date.now();
  const turns = [
    {
      role: 'interviewer' as const,
      text: 'Can you debug LRUCache on S3 when SQL timeout throws ECONNRESET?',
      timestamp: now - 2000,
    },
    {
      role: 'user' as const,
      text: 'Stack trace: TypeError at parseSQLRow -> LRUCache.get("S3Key")',
      timestamp: now - 1000,
    },
  ];

  const reasoningPrepared = prepareTranscriptForReasoning(turns, 12);
  assert.match(reasoningPrepared, /LRUCache/);
  assert.match(reasoningPrepared, /S3/);
  assert.match(reasoningPrepared, /SQL/);
  assert.match(reasoningPrepared, /ECONNRESET/);
  assert.match(reasoningPrepared, /TypeError/);

  const standardPrepared = prepareTranscriptForWhatToAnswer(turns, 12);
  assert.doesNotMatch(standardPrepared, /LRUCache/);
  assert.doesNotMatch(standardPrepared, /ECONNRESET/);
});
