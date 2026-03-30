import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkTranscript, formatChunkForContext } from '../rag/SemanticChunker';

test('semantic chunker splits on topic shift after sentence boundary', () => {
  const chunks = chunkTranscript('m1', [
    { speaker: 'interviewer', text: 'Let us talk about your backend work. You improved throughput significantly.', startMs: 0, endMs: 1000, isQuestion: false, isDecision: false, isActionItem: false },
    { speaker: 'interviewer', text: 'You also redesigned the data model.', startMs: 1001, endMs: 2000, isQuestion: false, isDecision: false, isActionItem: false },
    { speaker: 'interviewer', text: 'Now switching gears, tell me about a leadership challenge you handled.', startMs: 2001, endMs: 3000, isQuestion: true, isDecision: false, isActionItem: false },
  ]);

  assert.equal(chunks.length, 2);
  assert.match(chunks[1].text, /leadership challenge/);
});

test('semantic chunker handles empty input, speaker changes, overlap, and oversized segments', () => {
  assert.deepEqual(chunkTranscript('m0', []), []);

  const speakerChunks = chunkTranscript('m2', [
    { speaker: 'Speaker', text: 'First speaker statement with enough words to count.', startMs: 0, endMs: 1000, isQuestion: false, isDecision: false, isActionItem: false },
    { speaker: 'You', text: 'Second speaker statement should force a split.', startMs: 1001, endMs: 2000, isQuestion: false, isDecision: false, isActionItem: false },
  ]);

  assert.equal(speakerChunks.length, 2);
  assert.equal(speakerChunks[0].speaker, 'Speaker');
  assert.equal(speakerChunks[1].speaker, 'You');

  const repeatedText = 'word '.repeat(110).trim();
  const overlapChunks = chunkTranscript('m3', [
    { speaker: 'Speaker', text: repeatedText, startMs: 0, endMs: 1000, isQuestion: false, isDecision: false, isActionItem: false },
    { speaker: 'Speaker', text: repeatedText, startMs: 1001, endMs: 2000, isQuestion: false, isDecision: false, isActionItem: false },
    { speaker: 'Speaker', text: repeatedText, startMs: 2001, endMs: 3000, isQuestion: false, isDecision: false, isActionItem: false },
  ]);

  assert.equal(overlapChunks.length, 2);
  assert.equal(overlapChunks[0].chunkIndex, 0);
  assert.equal(overlapChunks[1].chunkIndex, 1);
  assert.match(overlapChunks[1].text, /^word /);
  assert.ok(overlapChunks[1].tokenCount > 0);

  const oversized = chunkTranscript('m4', [
    { speaker: 'Speaker', text: 'x'.repeat(1800), startMs: 0, endMs: 1000, isQuestion: false, isDecision: false, isActionItem: false },
  ]);

  assert.equal(oversized.length, 1);
  assert.ok(oversized[0].tokenCount > 400);
});

test('formatChunkForContext renders mm:ss timestamp', () => {
  const formatted = formatChunkForContext({
    meetingId: 'm5',
    chunkIndex: 3,
    speaker: 'Natively',
    startMs: 125000,
    endMs: 130000,
    text: 'Here is the answer.',
    tokenCount: 4,
  });

  assert.equal(formatted, '[2:05] Natively: Here is the answer.');
});
