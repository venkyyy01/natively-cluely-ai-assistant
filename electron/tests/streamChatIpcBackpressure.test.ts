// electron/tests/streamChatIpcBackpressure.test.ts
//
// NAT-019 / audit R-7: pin the IPC token-batching policy. The IPC handler
// in `electron/ipcHandlers.ts` re-implements this logic inline (so we
// don't have to import an Electron-coupled module from a node:test
// runner), but the policy lives in `electron/streaming/StreamTokenBatcher.ts`
// and this test guarantees:
//
//   - a high token rate produces at most 64 sends/sec (= one per 16 ms),
//   - flushing happens before the buffer grows unbounded,
//   - a destroyed sender aborts the loop and refuses further work.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StreamTokenBatcher,
  STREAM_TOKEN_BATCHER_DEFAULTS,
} from '../streaming/StreamTokenBatcher';

test('NAT-019: high token rate is capped at <= 64 sends/sec', () => {
  // Simulate 1 second of streaming at 500 tokens/sec, 16 ms apart.
  // Without batching this would be 500 IPC sends. With batching the
  // ceiling is roughly 1000 / intervalMs = 62.5 sends.
  let clock = 0;
  const sent: string[] = [];
  const batcher = new StreamTokenBatcher({
    intervalMs: STREAM_TOKEN_BATCHER_DEFAULTS.INTERVAL_MS,
    maxTokens: STREAM_TOKEN_BATCHER_DEFAULTS.MAX_TOKENS,
    send: (chunk) => sent.push(chunk),
    isDestroyed: () => false,
    now: () => clock,
  });

  for (let i = 0; i < 500; i += 1) {
    batcher.push('x');
    clock += 2; // 500 tokens / sec -> 2 ms apart
  }
  batcher.flush();

  // 500 tokens at 2 ms apart = 1000 ms wallclock. Maximum allowed sends
  // is 64. Each send carries a coalesced chunk; together they reproduce
  // the original token stream exactly.
  assert.ok(
    sent.length <= 64,
    `expected at most 64 sends, got ${sent.length}`,
  );
  assert.equal(sent.join(''), 'x'.repeat(500), 'every token must be emitted');
});

test('NAT-019: max-tokens cap forces a flush even before interval elapses', () => {
  let clock = 0;
  const sent: string[] = [];
  const batcher = new StreamTokenBatcher({
    intervalMs: 10_000, // huge — never trips on time
    maxTokens: 4,
    send: (chunk) => sent.push(chunk),
    isDestroyed: () => false,
    now: () => clock,
  });

  // 12 tokens, 1 ms apart -> intervalMs never trips, so only the
  // max-tokens path can flush. Expect 3 batches of 4.
  for (let i = 0; i < 12; i += 1) {
    batcher.push(String(i));
    clock += 1;
  }
  batcher.flush();

  assert.deepEqual(sent, ['0123', '4567', '891011']);
});

test('NAT-019: destroyed sender aborts the loop and refuses further pushes', () => {
  let destroyed = false;
  const sent: string[] = [];
  const batcher = new StreamTokenBatcher({
    intervalMs: 100,
    maxTokens: 100,
    send: (chunk) => sent.push(chunk),
    isDestroyed: () => destroyed,
  });

  for (let i = 0; i < 5; i += 1) batcher.push('a');
  destroyed = true;

  // Subsequent pushes return false and never produce a send.
  assert.equal(batcher.push('b'), false, 'push must report aborted');
  assert.equal(batcher.flush(), false, 'flush must report aborted');
  assert.equal(batcher.isAborted(), true);
  // Whatever was buffered before the destroy goes nowhere — that is the
  // safe choice; the renderer is gone, sending would throw.
  assert.equal(sent.length, 0);
});

test('NAT-019: getStats reports tokens, sends, and aborted state', () => {
  let clock = 0;
  const sent: string[] = [];
  const batcher = new StreamTokenBatcher({
    intervalMs: 1, // trivially trips after every token
    maxTokens: 100,
    send: (chunk) => sent.push(chunk),
    isDestroyed: () => false,
    now: () => clock,
  });

  batcher.push('a');
  clock += 5;
  batcher.push('b');
  clock += 5;
  batcher.push('c');
  batcher.flush();

  const stats = batcher.getStats();
  assert.equal(stats.tokens, 3);
  assert.equal(stats.aborted, false);
  assert.ok(stats.sends >= 1 && stats.sends <= 3);
});
