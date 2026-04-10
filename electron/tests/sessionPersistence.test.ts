import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    consciousState: {
      threadState: {
        latestConsciousResponse: {
          mode: 'reasoning_first',
          openingReasoning: 'I would start with a cache aside strategy.',
          implementationPlan: ['Use Redis'],
          tradeoffs: ['Cold starts cost more'],
          edgeCases: [],
          scaleConsiderations: [],
          pushbackResponses: [],
          likelyFollowUps: [],
          codeTransition: '',
        },
        activeReasoningThread: {
          rootQuestion: 'How would you design a cache?',
          lastQuestion: 'How would you design a cache?',
          response: {
            mode: 'reasoning_first',
            openingReasoning: 'I would start with a cache aside strategy.',
            implementationPlan: ['Use Redis'],
            tradeoffs: ['Cold starts cost more'],
            edgeCases: [],
            scaleConsiderations: [],
            pushbackResponses: [],
            likelyFollowUps: [],
            codeTransition: '',
          },
          followUpCount: 1,
          updatedAt: now,
        },
      },
      hypothesisState: {
        latestHypothesis: {
          sourceQuestion: 'What are the tradeoffs?',
          latestSuggestedAnswer: 'Use cache aside with Redis.',
          likelyThemes: ['cache aside', 'redis'],
          confidence: 0.81,
          evidence: ['suggested', 'inferred'],
          reactionKind: 'tradeoff_probe',
          targetFacets: ['tradeoffs'],
          updatedAt: now,
        },
        latestReaction: {
          kind: 'tradeoff_probe',
          confidence: 0.88,
          cues: ['tradeoff_language'],
          targetFacets: ['tradeoffs'],
          shouldContinueThread: true,
        },
      },
    },
    memoryState: {
      hot: [
        {
          id: 'hot-transcript-1',
          sizeBytes: 64,
          createdAt: now,
          value: {
            kind: 'transcript',
            text: 'Walk me through your cache invalidation strategy.',
            timestamp: now,
            speaker: 'interviewer',
            final: true,
          },
        },
      ],
      warm: [
        {
          id: 'warm-thread',
          sizeBytes: 48,
          createdAt: now,
          value: {
            kind: 'active-thread',
            timestamp: now,
            topic: 'Design cache',
            goal: 'Discuss cache architecture',
            phase: 'high_level_design',
            turnCount: 3,
          },
        },
      ],
      cold: [],
    },
  };
}

async function createPersistenceDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'natively-session-persistence-'));
}

test('SessionPersistence saves and loads meeting sessions', async (t) => {
  const sessionsDirectory = await createPersistenceDir();
  t.after(async () => {
    await rm(sessionsDirectory, { recursive: true, force: true });
  });

  const persistence = new SessionPersistence({ sessionsDirectory });
  await persistence.init();

  const session = makeSession(`meeting_${Date.now()}`);
  await persistence.save(session);

  const loaded = await persistence.findByMeeting(session.meetingId);
  assert.ok(loaded);
  assert.equal(loaded?.sessionId, session.sessionId);
  assert.equal(loaded?.activeThread?.topic, 'Design cache');
  assert.equal(loaded?.consciousState?.threadState?.latestConsciousResponse?.openingReasoning, 'I would start with a cache aside strategy.');
  assert.equal(loaded?.consciousState?.hypothesisState?.latestReaction?.kind, 'tradeoff_probe');
  assert.equal(loaded?.memoryState?.hot[0]?.value.text, 'Walk me through your cache invalidation strategy.');
});

test('SessionPersistence flushScheduledSave persists pending snapshots immediately', async (t) => {
  const sessionsDirectory = await createPersistenceDir();
  t.after(async () => {
    await rm(sessionsDirectory, { recursive: true, force: true });
  });

  const persistence = new SessionPersistence({ sessionsDirectory });
  await persistence.init();

  const session = makeSession(`meeting_flush_${Date.now()}`);
  persistence.scheduleSave(session);
  await persistence.flushScheduledSave();

  const loaded = await persistence.findByMeeting(session.meetingId);
  assert.ok(loaded);
  assert.equal(loaded?.sessionId, session.sessionId);
});
