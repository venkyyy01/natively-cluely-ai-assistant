import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStealthRedactionPatternsForTesting,
  redactStealthSubstrings,
} from '../stealth/logRedactor';

test('redactStealthSubstrings strips StealthManager prefix from log lines', () => {
  const line = '[LOG] [StealthManager] enabled with privacy=true';
  const out = redactStealthSubstrings(line);
  assert.equal(out.includes('StealthManager'), false);
  assert.equal(out.includes('[REDACTED]'), true);
  assert.equal(out.startsWith('[LOG]'), true);
});

test('redactStealthSubstrings rewrites virtual-display and capture-bypass mentions', () => {
  const line =
    '[LOG] virtual-display coordinator armed; capture-bypass active for Loom';
  const out = redactStealthSubstrings(line);
  assert.equal(out.includes('virtual-display'), false);
  assert.equal(out.includes('capture-bypass'), false);
  assert.equal((out.match(/\[REDACTED\]/g) || []).length >= 2, true);
});

test('redactStealthSubstrings is case-insensitive and idempotent', () => {
  const line =
    '[WARN] STEALTHMANAGER restart triggered by isUndetectable check';
  const first = redactStealthSubstrings(line);
  const second = redactStealthSubstrings(first);
  assert.equal(first, second);
  assert.equal(/stealth/i.test(first), false);
  assert.equal(/isUndetectable/i.test(first), false);
});

test('redactStealthSubstrings leaves unrelated diagnostics alone', () => {
  const line = '[ERROR] Failed to load model gpt-4o-mini: timeout 30s';
  const out = redactStealthSubstrings(line);
  assert.equal(out, line);
});

test('getStealthRedactionPatternsForTesting exposes a non-empty pattern list', () => {
  const patterns = getStealthRedactionPatternsForTesting();
  assert.equal(Array.isArray(patterns), true);
  assert.equal(patterns.length > 0, true);
  for (const pattern of patterns) {
    assert.equal(pattern instanceof RegExp, true);
  }
});

test('redactStealthSubstrings strips macOS-specific helper class names', () => {
  const line =
    '[LOG] MacosVirtualDisplayCoordinator handing off to MacosStealthEnhancer';
  const out = redactStealthSubstrings(line);
  assert.equal(/MacosVirtualDisplay/.test(out), false);
  assert.equal(/MacosStealthEnhancer/.test(out), false);
});
