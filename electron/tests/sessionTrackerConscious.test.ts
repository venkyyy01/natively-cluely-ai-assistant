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
  } finally {
    persistence.findByMeeting = originalFindByMeeting;
  }
});
