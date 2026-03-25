import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../SessionTracker';

test('SessionTracker reuses compact snapshots per session and invalidates on transcript revision changes', () => {
  const session = new SessionTracker();
  session.addTranscript({ speaker: 'interviewer', text: 'How would you design a cache?', timestamp: 1, final: true });

  const first = session.getCompactTranscriptSnapshot(12, 'fast');
  const second = session.getCompactTranscriptSnapshot(12, 'fast');
  assert.equal(first, second);

  const revisionBefore = session.getTranscriptRevision();
  session.addAssistantMessage('I would start with cache-aside and a clear invalidation policy.');
  const revisionAfter = session.getTranscriptRevision();
  assert.ok(revisionAfter > revisionBefore);

  const third = session.getCompactTranscriptSnapshot(12, 'fast');
  assert.notEqual(third, first);

  const sessionIdBeforeReset = session.getSessionId();
  session.reset();
  assert.notEqual(session.getSessionId(), sessionIdBeforeReset);
});
