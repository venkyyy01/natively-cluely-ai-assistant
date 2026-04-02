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

test('SessionTracker Conscious Integration - should keep live conscious state from user transcript too', () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);

  tracker.handleTranscript({
    speaker: 'user',
    text: 'I would start with the high level architecture and separate the write path from the read path',
    timestamp: Date.now(),
    final: true,
  });

  assert.equal(tracker.getCurrentPhase(), 'high_level_design');
  assert.ok(tracker.getThreadManager().getActiveThread());
  assert.equal(tracker.getThreadManager().getActiveThread()?.phase, 'high_level_design');
});

test('SessionTracker Conscious Integration - should not create a new live thread from a generic user answer', () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);

  tracker.handleTranscript({
    speaker: 'user',
    text: 'I worked with a small team and iterated directly from customer feedback.',
    timestamp: Date.now(),
    final: true,
  });

  assert.equal(tracker.getThreadManager().getActiveThread(), null);
});

test('SessionTracker Conscious Integration - should clear derived Conscious state on mode-off without clearing transcript history', () => {
  const tracker = new SessionTracker();
  tracker.setConsciousModeEnabled(true);

  tracker.handleTranscript({
    speaker: 'interviewer',
    text: 'Let me walk through the high level architecture and main components',
    timestamp: Date.now(),
    final: true,
  });
  tracker.recordConsciousResponse('How would you design this system?', {
    mode: 'reasoning_first',
    openingReasoning: 'I would start by clarifying scale and consistency constraints.',
    implementationPlan: ['Define the write path first'],
    tradeoffs: ['More moving pieces'],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
  }, 'start');

  assert.equal(tracker.getCurrentPhase(), 'high_level_design');
  assert.ok(tracker.getThreadManager().getActiveThread());
  assert.equal(tracker.getLatestConsciousResponse()?.mode, 'reasoning_first');
  assert.equal(tracker.getFullTranscript().length, 1);

  tracker.setConsciousModeEnabled(false);

  assert.equal(tracker.isConsciousModeEnabled(), false);
  assert.equal(tracker.getLatestConsciousResponse(), null);
  assert.equal(tracker.getActiveReasoningThread(), null);
  assert.equal(tracker.getThreadManager().getActiveThread(), null);
  assert.equal(tracker.getCurrentPhase(), 'requirements_gathering');
  assert.equal(tracker.getFullTranscript().length, 1);

  tracker.setConsciousModeEnabled(true);

  assert.equal(tracker.getThreadManager().getActiveThread(), null);
  assert.equal(tracker.getCurrentPhase(), 'requirements_gathering');
});
