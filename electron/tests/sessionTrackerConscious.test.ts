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
