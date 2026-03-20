import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkTranscript } from '../rag/SemanticChunker';

test('semantic chunker splits on topic shift after sentence boundary', () => {
  const chunks = chunkTranscript('m1', [
    { speaker: 'interviewer', text: 'Let us talk about your backend work. You improved throughput significantly.', startMs: 0, endMs: 1000, isQuestion: false, isDecision: false, isActionItem: false },
    { speaker: 'interviewer', text: 'You also redesigned the data model.', startMs: 1001, endMs: 2000, isQuestion: false, isDecision: false, isActionItem: false },
    { speaker: 'interviewer', text: 'Now switching gears, tell me about a leadership challenge you handled.', startMs: 2001, endMs: 3000, isQuestion: true, isDecision: false, isActionItem: false },
  ]);

  assert.equal(chunks.length, 2);
  assert.match(chunks[1].text, /leadership challenge/);
});
