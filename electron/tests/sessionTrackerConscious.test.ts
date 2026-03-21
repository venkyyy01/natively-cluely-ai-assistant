// electron/tests/sessionTrackerConscious.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTracker } from '../SessionTracker';

describe('SessionTracker Conscious Integration', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
  });

  it('should initialize with thread manager', () => {
    expect(tracker.getThreadManager()).toBeDefined();
  });

  it('should initialize with phase detector', () => {
    expect(tracker.getPhaseDetector()).toBeDefined();
  });

  it('should get current interview phase', () => {
    const phase = tracker.getCurrentPhase();
    expect(phase).toBe('requirements_gathering'); // Default
  });

  it('should create thread on conscious mode activation', () => {
    tracker.setConsciousModeEnabled(true);
    const thread = tracker.getThreadManager().createThread('Test topic', 'high_level_design');
    expect(thread).toBeDefined();
    expect(thread.status).toBe('active');
  });
});
