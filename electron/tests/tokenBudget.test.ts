// electron/tests/tokenBudget.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetManager } from '../conscious/TokenBudget';

describe('TokenBudgetManager', () => {
  let manager: TokenBudgetManager;

  beforeEach(() => {
    manager = new TokenBudgetManager('openai');
  });

  it('should initialize with correct total budget for OpenAI', () => {
    expect(manager.getTotalBudget()).toBe(4000);
  });

  it('should initialize with correct total budget for Groq', () => {
    const groqManager = new TokenBudgetManager('groq');
    expect(groqManager.getTotalBudget()).toBe(3100);
  });

  it('should check if tokens can be added to bucket', () => {
    expect(manager.canAdd('activeThread', 500)).toBe(true);
    expect(manager.canAdd('activeThread', 5000)).toBe(false);
  });

  it('should allocate tokens to bucket', () => {
    manager.allocate('activeThread', 300);
    const allocations = manager.getAllocations();
    expect(allocations.activeThread.current).toBe(300);
  });

  it('should rebalance when bucket is underutilized', () => {
    manager.allocate('suspendedThreads', 0); // No suspended threads
    manager.rebalance();
    const allocations = manager.getAllocations();
    // Active thread should get more when suspended is empty
    expect(allocations.activeThread.max).toBeGreaterThan(1200);
  });

  it('should estimate tokens from text', () => {
    const text = "This is a test sentence with some words.";
    const tokens = manager.estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // Roughly 4 chars per token
  });
});
