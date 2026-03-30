import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResponseQuality } from '../llm/postProcessor';

test('should pass valid short response', () => {
  const response = "React uses virtual DOM. This improves performance.";
  const result = validateResponseQuality(response);
  assert.equal(result.isValid, true);
  assert.equal(result.violations.length, 0);
});

test('should fail on too many sentences', () => {
  const response = "First sentence. Second sentence. Third sentence.";
  const result = validateResponseQuality(response);
  assert.equal(result.isValid, false);
  assert.ok(result.violations.some((v: string) => v.includes('Too many sentences: 3/2')));
});

test('should fail on long sentences', () => {
  const response = "This is a really long sentence that definitely exceeds the twenty-five word limit that we have established for maintaining conciseness and clarity in all of our communications.";
  const result = validateResponseQuality(response);
  assert.equal(result.isValid, false);
  assert.ok(result.violations.some((v: string) => v.includes('too long')));
});

test('should detect AI-speak phrases', () => {
  const response = "That's a great question! Let me help you understand this.";
  const result = validateResponseQuality(response);
  assert.equal(result.isValid, false);
  assert.ok(result.violations.some((v: string) => v.includes('AI-speak')));
});