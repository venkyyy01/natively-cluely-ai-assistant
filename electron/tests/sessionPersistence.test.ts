import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionPersistence, PersistedSession } from '../memory/SessionPersistence';

function makeSession(meetingId: string): PersistedSession {
  const now = Date.now();
  return {
    version: 1,
    sessionId: `session_${meetingId}`,
    meetingId,
    createdAt: now,
    lastActiveAt: now,
    activeThread: {
      id: 'thread_1',
      topic: 'Design cache',
      goal: 'Discuss cache architecture',
      phase: 'high_level_design',
      turnCount: 3,
    },
    suspendedThreads: [],
    pinnedItems: [{ id: 'pin_1', text: 'Budget $200k', pinnedAt: now, label: 'budget' }],
    constraints: [{ type: 'budget', raw: '$200k', normalized: '$200,000' }],
    epochSummaries: ['Earlier context'],
    responseHashes: ['abc123'],
  };
}

test('SessionPersistence saves and loads meeting sessions', async () => {
  const persistence = new SessionPersistence();
  await persistence.init();

  const session = makeSession(`meeting_${Date.now()}`);
  await persistence.save(session);

  const loaded = await persistence.findByMeeting(session.meetingId);
  assert.ok(loaded);
  assert.equal(loaded?.sessionId, session.sessionId);
  assert.equal(loaded?.activeThread?.topic, 'Design cache');
});

test('SessionPersistence flushScheduledSave persists pending snapshots immediately', async () => {
  const persistence = new SessionPersistence();
  await persistence.init();

  const session = makeSession(`meeting_flush_${Date.now()}`);
  persistence.scheduleSave(session);
  await persistence.flushScheduledSave();

  const loaded = await persistence.findByMeeting(session.meetingId);
  assert.ok(loaded);
  assert.equal(loaded?.sessionId, session.sessionId);
});
