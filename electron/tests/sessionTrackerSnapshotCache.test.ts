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

  const formattedFirst = session.getFormattedContext(120);
  const formattedSecond = session.getFormattedContext(120);
  assert.equal(formattedFirst, formattedSecond);

  const sessionIdBeforeReset = session.getSessionId();
  session.reset();
  assert.notEqual(session.getSessionId(), sessionIdBeforeReset);
});

test('SessionTracker stores semantic metadata on context items and limits constraint extraction scope', () => {
  const session = new SessionTracker();
  const now = Date.now();

  session.addTranscript({
    speaker: 'interviewer',
    text: 'We have a strict budget of $150k for this project.',
    timestamp: now,
    final: true,
  });

  const context = session.getContext(120);
  const first = context[0];
  assert.ok(first);
  assert.ok(Array.isArray(first.embedding));
  assert.ok(first.embedding && first.embedding.length > 0);
  assert.ok(first.phase);

  const beforeConstraints = session.getConstraintSummary().length;
  session.addAssistantMessage('Given the budget, I would phase delivery and reduce infra spend.');
  const afterConstraints = session.getConstraintSummary().length;
  assert.equal(afterConstraints, beforeConstraints);
});
