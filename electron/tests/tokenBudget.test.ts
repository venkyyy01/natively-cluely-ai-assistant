// electron/tests/tokenBudget.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBudgetManager } from '../conscious/TokenBudget';

test('TokenBudgetManager - should initialize with correct total budget for OpenAI', () => {
  const manager = new TokenBudgetManager('openai');
  assert.equal(manager.getTotalBudget(), 4000);
});

test('TokenBudgetManager - should initialize with correct total budget for Groq', () => {
  const groqManager = new TokenBudgetManager('groq');
  assert.equal(groqManager.getTotalBudget(), 3100);
});

test('TokenBudgetManager - should check if tokens can be added to bucket', () => {
  const manager = new TokenBudgetManager('openai');
  assert.equal(manager.canAdd('activeThread', 500), true);
  assert.equal(manager.canAdd('activeThread', 5000), false);
});

test('TokenBudgetManager - should allocate tokens to bucket', () => {
  const manager = new TokenBudgetManager('openai');
  manager.allocate('activeThread', 300);
  const allocations = manager.getAllocations();
  assert.equal(allocations.activeThread.current, 300);
});

test('TokenBudgetManager - should rebalance when bucket is underutilized', () => {
  const manager = new TokenBudgetManager('openai');
  manager.allocate('suspendedThreads', 0); // No suspended threads
  manager.rebalance();
  const allocations = manager.getAllocations();
  // Active thread should get more when suspended is empty
  assert.ok(allocations.activeThread.max > 1200);
});

test('TokenBudgetManager - should estimate tokens from text', () => {
  const manager = new TokenBudgetManager('openai');
  const text = "This is a test sentence with some words.";
  const tokens = manager.estimateTokens(text);
  assert.ok(tokens > 0);
  assert.ok(tokens < text.length);
});
