// electron/tests/sessionTrackerConscious.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../SessionTracker';

test('SessionTracker Conscious Integration - should initialize with thread manager', () => {
  const tracker = new SessionTracker();
  assert.ok(tracker.getThreadManager());
});

test('SessionTracker Conscious Integration - should initialize with phase detector', () => {
  const tracker = new SessionTracker();
  assert.ok(tracker.getPhaseDetector());
});

test('SessionTracker Conscious Integration - should get current interview phase', () => {
  const tracker = new SessionTracker();
  const phase = tracker.getCurrentPhase();
  assert.equal(phase, 'requirements_gathering'); // Default
});

test('SessionTracker Conscious Integration - should create thread on conscious mode activation', () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);
  const thread = tracker.getThreadManager().createThread('Test topic', 'high_level_design');
  assert.ok(thread);
  assert.equal(thread.status, 'active');
});

test('SessionTracker Conscious Integration - auto-pins extracted constraints from transcript', () => {
  const tracker = new SessionTracker();
  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'We have a $300k budget and 6 engineers for a 3 month timeline.',
    timestamp: Date.now(),
    final: true,
  });

  const pinned = tracker.getPinnedItems();
  assert.ok(pinned.length > 0);
  assert.ok(pinned.some((item) => item.label === 'budget'));
});

test('SessionTracker Conscious Integration - should keep live conscious state from interviewer transcript', () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);

  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'Let me walk through the high level architecture and main components',
    timestamp: Date.now(),
    final: true,
  });

  assert.equal(tracker.getCurrentPhase(), 'high_level_design');
  assert.ok(tracker.getThreadManager().getActiveThread());
  assert.equal(tracker.getThreadManager().getActiveThread()?.phase, 'high_level_design');
});

test('SessionTracker Conscious Integration - builds long memory context from thread, constraints, pins, and summaries', () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);

  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'We have a $300k budget and six engineers. How would you design a rate limiter for an API?',
    timestamp: Date.now() - 2000,
    final: true,
  });
  tracker.recordConsciousResponse('How would you design a rate limiter for an API?', {
    mode: 'reasoning_first',
    openingReasoning: 'I would start with a per-user token bucket backed by Redis.',
    implementationPlan: ['Use Redis for counters'],
    tradeoffs: ['Redis adds operational overhead'],
    edgeCases: ['Clock skew across regions'],
    scaleConsiderations: ['Shard counters for hot tenants'],
    pushbackResponses: ['I chose operational simplicity first.'],
    likelyFollowUps: [],
    codeTransition: '',
  }, 'start');
  tracker.pinItem('Use Redis sorted sets for rolling windows', 'design');
  (tracker as any).transcriptEpochSummaries = ['Earlier discussion covered sharding, hotspots, and failover plans.'];

  const memoryBlock = tracker.getConsciousLongMemoryContext('How do you handle hotspots and failover in the rate limiter?');

  assert.match(memoryBlock, /ACTIVE_THREAD_TOPIC:/);
  assert.match(memoryBlock, /KEY_CONSTRAINTS:/);
  assert.match(memoryBlock, /PINNED_MEMORY:/);
  assert.match(memoryBlock, /EARLIER_SESSION_SUMMARIES:/);
  assert.match(memoryBlock, /LATEST_REASONING_SUMMARY:/);
  assert.match(memoryBlock, /<design_state>/);
  assert.match(memoryBlock, /SCALING_PLAN:/);
});

test('SessionTracker Conscious Integration - retrieves design-state facts for long-horizon follow-ups', async () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);

  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'Design a billing ledger with strict correctness and an append-only data model.',
    timestamp: Date.now() - 3000,
    final: true,
  });
  tracker.recordConsciousResponse('How would you design a billing ledger?', {
    mode: 'reasoning_first',
    openingReasoning: 'I would separate the write path from the read path.',
    implementationPlan: [
      'Expose an idempotent write API for ledger mutations',
      'Use an append-only ledger table with secondary indexes for account lookups',
    ],
    tradeoffs: ['Strict consistency increases write latency'],
    edgeCases: ['Duplicate payment webhooks must stay idempotent'],
    scaleConsiderations: ['Shard by account for hot enterprise tenants'],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
  }, 'start');

  const context = await tracker.getConsciousRelevantContext('What failure modes and schema choices matter most in the ledger?', 900);
  const joined = context.map((item) => item.text).join('\n');

  assert.match(joined, /Duplicate payment webhooks must stay idempotent/);
  assert.match(joined, /(append-only data model|append-only ledger table)/i);
});

test('SessionTracker ensureMeetingContext keeps latest meeting id when restores overlap', async () => {
  const tracker = new SessionTracker();
  const persistence = (tracker as any).persistence;

  let releaseFirst: (() => void) | null = null;
  const firstRestoreGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const originalFindByMeeting = persistence.findByMeeting.bind(persistence);
  persistence.findByMeeting = async (meetingId: string) => {
    if (meetingId === 'meeting-old') {
      await firstRestoreGate;
      return {
        version: 1,
        sessionId: 'old-session',
        meetingId,
        createdAt: Date.now() - 1000,
        lastActiveAt: Date.now(),
        activeThread: null,
        suspendedThreads: [],
        pinnedItems: [],
        constraints: [],
        epochSummaries: [],
        responseHashes: [],
      };
    }

    if (meetingId === 'meeting-new') {
      return null;
    }

    return originalFindByMeeting(meetingId);
  };

  try {
    tracker.ensureMeetingContext('meeting-old');
    tracker.ensureMeetingContext('meeting-new');

    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal((tracker as any).activeMeetingId, 'meeting-new');
  } finally {
    persistence.findByMeeting = originalFindByMeeting;
  }
});

test('SessionTracker restoreFromMeetingId restores conscious reasoning and hypothesis state', async () => {
  const tracker = new SessionTracker();
  const persistence = (tracker as any).persistence;

  const originalFindByMeeting = persistence.findByMeeting.bind(persistence);
  persistence.findByMeeting = async (meetingId: string) => {
    if (meetingId !== 'meeting-conscious') {
      return originalFindByMeeting(meetingId);
    }

    const now = Date.now();
    return {
      version: 1,
      sessionId: 'session-conscious',
      meetingId,
      createdAt: now - 1000,
      lastActiveAt: now,
      activeThread: {
        id: 'thread_123',
        topic: 'How would you design a cache?',
        goal: 'Discuss cache architecture',
        phase: 'high_level_design',
        turnCount: 2,
      },
      suspendedThreads: [],
      pinnedItems: [],
      constraints: [],
      epochSummaries: [],
      responseHashes: [],
      consciousState: {
        threadState: {
          latestConsciousResponse: {
            mode: 'reasoning_first',
            openingReasoning: 'I would start with cache aside.',
            implementationPlan: ['Use Redis'],
            tradeoffs: ['Cold misses still hit the database'],
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
              openingReasoning: 'I would start with cache aside.',
              implementationPlan: ['Use Redis'],
              tradeoffs: ['Cold misses still hit the database'],
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
            latestSuggestedAnswer: 'I would start with cache aside.',
            likelyThemes: ['cache aside', 'redis'],
            confidence: 0.79,
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
        designState: {
          currentObjective: 'How would you design a cache?',
          updatedAt: now,
          entries: [
            {
              facet: 'architecture',
              text: 'Use Redis for the hot path.',
              normalized: 'use redis for the hot path.',
              timestamp: now,
              source: 'reasoning',
              boost: 0.22,
              keywords: ['redis', 'hot', 'path'],
            },
            {
              facet: 'tradeoffs',
              text: 'Cold misses still hit the database.',
              normalized: 'cold misses still hit the database.',
              timestamp: now,
              source: 'reasoning',
              boost: 0.2,
              keywords: ['cold', 'misses', 'database'],
            },
          ],
        },
      },
    };
  };

  try {
    const restored = await tracker.restoreFromMeetingId('meeting-conscious');
    assert.equal(restored, true);
    assert.equal(tracker.getLatestConsciousResponse()?.openingReasoning, 'I would start with cache aside.');
    assert.equal(tracker.getActiveReasoningThread()?.rootQuestion, 'How would you design a cache?');
    assert.equal(tracker.getLatestQuestionReaction()?.kind, 'tradeoff_probe');
    assert.ok(tracker.getConsciousEvidenceContext().includes('tradeoff_probe'));
    assert.ok(tracker.getConsciousLongMemoryContext('What tradeoffs matter in the cache?').includes('ARCHITECTURE_DECISIONS:'));
  } finally {
    persistence.findByMeeting = originalFindByMeeting;
  }
});

test('SessionTracker restoreFromMeetingId rebuilds recent transcript and usage from persisted memory state', async () => {
  const tracker = new SessionTracker();
  const persistence = (tracker as any).persistence;

  const originalFindByMeeting = persistence.findByMeeting.bind(persistence);
  persistence.findByMeeting = async (meetingId: string) => {
    if (meetingId !== 'meeting-memory-restore') {
      return originalFindByMeeting(meetingId);
    }

    const now = Date.now();
    return {
      version: 1,
      sessionId: 'session-memory-restore',
      meetingId,
      createdAt: now - 1000,
      lastActiveAt: now,
      activeThread: null,
      suspendedThreads: [],
      pinnedItems: [{ id: 'pin_1', text: 'Latency matters', pinnedAt: now, label: 'constraint' }],
      constraints: [{ type: 'latency', raw: 'Latency matters', normalized: 'latency matters' }],
      epochSummaries: ['Earlier design discussion'],
      responseHashes: [],
      memoryState: {
        hot: [
          {
            id: 'hot-transcript-1',
            sizeBytes: 64,
            createdAt: now - 200,
            value: {
              kind: 'transcript',
              text: 'Can you optimize the cache writes?',
              timestamp: now - 200,
              speaker: 'interviewer',
              final: true,
            },
          },
          {
            id: 'hot-usage-1',
            sizeBytes: 64,
            createdAt: now - 100,
            value: {
              kind: 'usage',
              timestamp: now - 100,
              usageType: 'assist',
              question: 'cache writes',
              answer: 'Use batched invalidation',
            },
          },
        ],
        warm: [],
        cold: [
          {
            id: 'cold-transcript-1',
            sizeBytes: 64,
            createdAt: now - 500,
            value: {
              kind: 'transcript',
              text: 'Start with cache aside.',
              timestamp: now - 500,
              speaker: 'assistant',
              final: true,
            },
          },
        ],
      },
    };
  };

  try {
    const restored = await tracker.restoreFromMeetingId('meeting-memory-restore');
    assert.equal(restored, true);
    assert.deepEqual(
      tracker.getFullTranscript().map((segment) => segment.text),
      ['Start with cache aside.', 'Can you optimize the cache writes?'],
    );
    assert.equal(tracker.getLastAssistantMessage(), 'Start with cache aside.');
    assert.equal(tracker.getFullUsage()[0]?.answer, 'Use batched invalidation');
    assert.equal(tracker.getContext(120).some((item) => item.text === 'Can you optimize the cache writes?'), true);
  } finally {
    persistence.findByMeeting = originalFindByMeeting;
  }
});
