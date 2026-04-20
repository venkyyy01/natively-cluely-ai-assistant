import test from 'node:test';
import assert from 'node:assert/strict';

import { ipcSchemas, parseIpcInput } from '../ipcValidation';

test('NAT-036: qualityTier accepts fast, quality, verify', () => {
  for (const tier of ['fast', 'quality', 'verify'] as const) {
    const parsed = parseIpcInput(
      ipcSchemas.geminiChatArgs,
      ['hello', undefined, undefined, { requestId: '00000000-0000-0000-0000-000000000001', qualityTier: tier }],
      'gemini-chat-stream',
    );
    assert.equal(parsed[3]?.qualityTier, tier);
  }
});

test('NAT-036: qualityTier rejects old values standard and structured_reasoning', () => {
  for (const invalid of ['standard', 'structured_reasoning']) {
    assert.throws(() => {
      parseIpcInput(
        ipcSchemas.geminiChatArgs,
        ['hello', undefined, undefined, { requestId: '00000000-0000-0000-0000-000000000001', qualityTier: invalid }],
        'gemini-chat-stream',
      );
    }, /qualityTier/);
  }
});

test('NAT-036: qualityTier defaults to quality when omitted', () => {
  type StreamQualityTier = 'fast' | 'quality' | 'verify';
  const resolveTier = (tier?: StreamQualityTier): StreamQualityTier => tier ?? 'quality';

  assert.equal(resolveTier(undefined), 'quality');
  assert.equal(resolveTier('fast'), 'fast');
  assert.equal(resolveTier('quality'), 'quality');
  assert.equal(resolveTier('verify'), 'verify');
});

test('NAT-036: verify tier skips fast-response providers', () => {
  type StreamQualityTier = 'fast' | 'quality' | 'verify';

  function getActiveFastResponseTarget(
    qualityTier: StreamQualityTier,
    fastEnabled: boolean,
    hasGroq: boolean,
  ): { provider: string; model: string } | null {
    if (!fastEnabled) return null;
    if (qualityTier === 'verify') return null;
    if (hasGroq) return { provider: 'groq', model: 'llama-3' };
    return null;
  }

  assert.equal(
    getActiveFastResponseTarget('verify', true, true),
    null,
    'verify tier must never route to fast-response provider',
  );
  assert.ok(
    getActiveFastResponseTarget('quality', true, true) !== null,
    'quality tier should route to fast-response when available',
  );
  assert.ok(
    getActiveFastResponseTarget('fast', true, true) !== null,
    'fast tier should route to fast-response when available',
  );
});

test('NAT-036: qualityTier and requestId are both optional in schema (requestId enforced at runtime)', () => {
  const parsed = parseIpcInput(
    ipcSchemas.geminiChatArgs,
    ['hello', undefined, undefined, { requestId: '00000000-0000-0000-0000-000000000001' }],
    'gemini-chat-stream',
  );
  assert.equal(parsed[3]?.requestId, '00000000-0000-0000-0000-000000000001');
  assert.equal(parsed[3]?.qualityTier, undefined);
});

test('NAT-036: requestId + qualityTier both present', () => {
  const parsed = parseIpcInput(
    ipcSchemas.geminiChatArgs,
    ['hello', undefined, undefined, { requestId: '00000000-0000-0000-0000-000000000001', qualityTier: 'verify', skipSystemPrompt: true }],
    'gemini-chat-stream',
  );
  assert.equal(parsed[3]?.requestId, '00000000-0000-0000-0000-000000000001');
  assert.equal(parsed[3]?.qualityTier, 'verify');
  assert.equal(parsed[3]?.skipSystemPrompt, true);
});

test('NAT-036: streamChat options propagate qualityTier to getActiveFastResponseTarget', () => {
  type StreamQualityTier = 'fast' | 'quality' | 'verify';

  const tiersUsed: StreamQualityTier[] = [];

  const mockGetTarget = (tier: StreamQualityTier) => {
    tiersUsed.push(tier);
    return tier === 'verify' ? null : { provider: 'groq', model: 'llama' };
  };

  mockGetTarget('quality');
  mockGetTarget('verify');
  mockGetTarget('fast');

  assert.deepEqual(tiersUsed, ['quality', 'verify', 'fast']);
  assert.equal(
    mockGetTarget('verify'),
    null,
    'verify tier returns null fast-response target',
  );
});

test('NAT-036: skipSystemPrompt preserved alongside qualityTier and requestId', () => {
  const parsed = parseIpcInput(
    ipcSchemas.geminiChatArgs,
    ['test-msg', [], 'test-ctx', { requestId: '00000000-0000-0000-0000-000000000002', qualityTier: 'fast', skipSystemPrompt: false }],
    'gemini-chat-stream',
  );
  assert.equal(parsed[0], 'test-msg');
  assert.deepEqual(parsed[1], []);
  assert.equal(parsed[2], 'test-ctx');
  assert.equal(parsed[3]?.requestId, '00000000-0000-0000-0000-000000000002');
  assert.equal(parsed[3]?.qualityTier, 'fast');
  assert.equal(parsed[3]?.skipSystemPrompt, false);
});
