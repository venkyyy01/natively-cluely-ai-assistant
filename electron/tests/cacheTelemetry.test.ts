/**
 * NAT-CACHE-AUDIT — tests for the prompt-cache telemetry shim used by the
 * OpenAI and Claude streaming providers.
 *
 * These tests pin the public contract so a Codex review can verify:
 *   - cache key derivation is stable across calls with the same system prompt
 *   - cache key derivation produces different values for different prompts
 *   - empty / undefined system prompts produce no cache key
 *   - the Claude system-param helper preserves legacy plain-string behavior
 *     for short prompts and only opts into cache_control for prompts that
 *     can plausibly hit the model's minimum cache threshold
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptCacheKey, buildClaudeSystemParam } from '../llm/providers/cacheTelemetry';

test('buildPromptCacheKey returns undefined for empty input', () => {
  assert.equal(buildPromptCacheKey(undefined), undefined);
  assert.equal(buildPromptCacheKey(null), undefined);
  assert.equal(buildPromptCacheKey(''), undefined);
  assert.equal(buildPromptCacheKey('   \n  '), undefined);
});

test('buildPromptCacheKey produces stable keys for the same prompt', () => {
  const a = buildPromptCacheKey('You are a helpful coding assistant.');
  const b = buildPromptCacheKey('You are a helpful coding assistant.');
  assert.equal(a, b);
  assert.ok(a?.startsWith('sys_'));
});

test('buildPromptCacheKey produces different keys for different prompts', () => {
  const a = buildPromptCacheKey('You are a helpful coding assistant.');
  const b = buildPromptCacheKey('You are a helpful systems architect.');
  assert.notEqual(a, b);
});

test('buildPromptCacheKey trims whitespace before hashing', () => {
  const a = buildPromptCacheKey('You are a helpful coding assistant.');
  const b = buildPromptCacheKey('  You are a helpful coding assistant.  \n');
  assert.equal(a, b);
});

test('buildPromptCacheKey output is short enough to fit OpenAI limits', () => {
  const huge = 'x'.repeat(100_000);
  const key = buildPromptCacheKey(huge);
  assert.ok(key);
  // sys_ prefix + 16 hex chars
  assert.equal(key!.length, 4 + 16);
});

test('buildClaudeSystemParam returns undefined when prompt is empty', () => {
  assert.equal(buildClaudeSystemParam(undefined), undefined);
  assert.equal(buildClaudeSystemParam(null), undefined);
  assert.equal(buildClaudeSystemParam(''), undefined);
  assert.equal(buildClaudeSystemParam('   \n  '), undefined);
});

test('buildClaudeSystemParam returns plain string for short prompts (legacy behavior)', () => {
  const result = buildClaudeSystemParam('You are an assistant.');
  assert.equal(typeof result, 'string');
  assert.equal(result, 'You are an assistant.');
});

test('buildClaudeSystemParam returns array with cache_control for long prompts', () => {
  const longPrompt = 'You are a helpful interview-coaching assistant. ' .repeat(40);
  const result = buildClaudeSystemParam(longPrompt);
  assert.ok(Array.isArray(result));
  if (Array.isArray(result)) {
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'text');
    assert.equal(result[0].text, longPrompt.trim());
    assert.deepEqual(result[0].cache_control, { type: 'ephemeral' });
  }
});

test('buildClaudeSystemParam trims input even for the array path', () => {
  const longPrompt = '   ' + 'You are a helpful interview-coaching assistant. '.repeat(40) + '   ';
  const result = buildClaudeSystemParam(longPrompt);
  if (Array.isArray(result)) {
    assert.ok(!result[0].text.startsWith(' '));
    assert.ok(!result[0].text.endsWith(' '));
  } else {
    assert.fail('expected array path for long prompt');
  }
});
