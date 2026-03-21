// electron/tests/threadManager.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ThreadManager } from '../conscious/ThreadManager';

describe('ThreadManager', () => {
  let manager: ThreadManager;

  beforeEach(() => {
    manager = new ThreadManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create a new thread', () => {
    const thread = manager.createThread('Design YouTube', 'high_level_design');
    expect(thread.topic).toBe('Design YouTube');
    expect(thread.phase).toBe('high_level_design');
    expect(thread.status).toBe('active');
  });

  it('should suspend active thread when creating new', () => {
    manager.createThread('Design YouTube', 'high_level_design');
    manager.createThread('Leadership story', 'behavioral_story');
    
    const suspended = manager.getSuspendedThreads();
    expect(suspended.length).toBe(1);
    expect(suspended[0].topic).toBe('Design YouTube');
    expect(suspended[0].status).toBe('suspended');
  });

  it('should limit suspended threads to 3', () => {
    manager.createThread('Thread 1', 'high_level_design');
    manager.createThread('Thread 2', 'deep_dive');
    manager.createThread('Thread 3', 'implementation');
    manager.createThread('Thread 4', 'scaling_discussion');
    manager.createThread('Thread 5', 'failure_handling');
    
    const suspended = manager.getSuspendedThreads();
    expect(suspended.length).toBe(3);
    expect(suspended.some(t => t.topic === 'Thread 1')).toBe(false); // Oldest evicted
  });

  it('should resume a suspended thread', () => {
    const original = manager.createThread('Design YouTube', 'high_level_design');
    manager.createThread('Leadership story', 'behavioral_story');
    
    const resumed = manager.resumeThread(original.id);
    expect(resumed).toBe(true);
    expect(manager.getActiveThread()?.topic).toBe('Design YouTube');
    expect(manager.getActiveThread()?.resumeCount).toBe(1);
  });

  it('should expire threads past TTL', () => {
    manager.createThread('Old thread', 'high_level_design');
    manager.createThread('New thread', 'behavioral_story');
    
    // Advance time past TTL (5 minutes)
    vi.advanceTimersByTime(6 * 60 * 1000);
    
    manager.pruneExpired();
    const suspended = manager.getSuspendedThreads();
    expect(suspended.length).toBe(0);
  });

  it('should find matching thread by keywords', () => {
    manager.createThread('Design caching layer', 'high_level_design');
    manager.createThread('Tell me about leadership', 'behavioral_story');
    
    const match = manager.findMatchingThread("Let's go back to the caching discussion");
    expect(match).not.toBeNull();
    expect(match?.thread.topic).toContain('caching');
  });
});
