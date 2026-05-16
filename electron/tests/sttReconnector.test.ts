import test from 'node:test';
import assert from 'node:assert/strict';

import { STTReconnector } from '../STTReconnector';

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('STTReconnector reconnects after the first error', async () => {
  let reconnects = 0;
  const reconnector = new STTReconnector(
    async () => {
      reconnects += 1;
    },
    { baseDelayMs: 1 },
  );

  reconnector.onError('interviewer');
  await wait(10);
  assert.equal(reconnects, 1);
  assert.equal(reconnector.getProviderHealth('interviewer').state, 'healthy');
});

test('STTReconnector emits reconnect lifecycle events', async () => {
  const events: string[] = [];
  const reconnector = new STTReconnector(async () => {}, { baseDelayMs: 1 });

  reconnector.on('reconnecting', ({ speaker }) => {
    events.push(`reconnecting:${speaker}`);
  });
  reconnector.on('reconnected', ({ speaker }) => {
    events.push(`reconnected:${speaker}`);
  });

  reconnector.onError('user');
  await wait(10);

  assert.deepEqual(events, ['reconnecting:user', 'reconnected:user']);
});

test('STTReconnector emits exhausted after bounded retries and enters cooldown', async () => {
  const events: string[] = [];
  let reconnectAttempts = 0;
  const reconnector = new STTReconnector(
    async () => {
      reconnectAttempts += 1;
      throw new Error('boom');
    },
    { baseDelayMs: 1, maxRetries: 3, cooldownMs: 50 },
  );

  reconnector.on('exhausted', ({ speaker }) => {
    events.push(speaker);
  });

  reconnector.onError('interviewer');
  await wait(20);

  assert.equal(reconnectAttempts, 3);
  assert.deepEqual(events, ['interviewer']);

  const health = reconnector.getProviderHealth('interviewer');
  assert.equal(health.state, 'down');
  assert.ok(health.cooldownRemainingMs > 0);
});

test('STTReconnector suppresses reconnect storms while provider cooldown is active', async () => {
  let reconnectAttempts = 0;
  const reconnector = new STTReconnector(
    async () => {
      reconnectAttempts += 1;
      throw new Error('boom');
    },
    { baseDelayMs: 1, maxRetries: 1, cooldownMs: 40 },
  );

  reconnector.onError('user');
  await wait(10);
  assert.equal(reconnectAttempts, 1);

  // During cooldown: additional errors should be ignored.
  reconnector.onError('user');
  reconnector.onError('user');
  await wait(10);
  assert.equal(reconnectAttempts, 1);

  // After cooldown: reconnect is allowed again.
  await wait(50);
  reconnector.onError('user');
  await wait(10);
  assert.equal(reconnectAttempts, 2);
});

test('STTReconnector reports degraded state while retries are in progress', async () => {
  const reconnector = new STTReconnector(
    async () => {
      throw new Error('transient');
    },
    { baseDelayMs: 5, maxRetries: 2, cooldownMs: 25 },
  );

  assert.equal(reconnector.getProviderHealth('interviewer').state, 'healthy');
  reconnector.onError('interviewer');

  // Immediately after first error, reconnect should be queued and lane marked degraded.
  assert.equal(reconnector.getProviderHealth('interviewer').state, 'degraded');

  await wait(20);
  assert.equal(reconnector.getProviderHealth('interviewer').state, 'down');
});

test('STTReconnector reset clears retry/cooldown and restores healthy state', async () => {
  const reconnector = new STTReconnector(
    async () => {
      throw new Error('boom');
    },
    { baseDelayMs: 1, maxRetries: 1, cooldownMs: 100 },
  );

  reconnector.onError('interviewer');
  await wait(10);

  assert.equal(reconnector.getProviderHealth('interviewer').state, 'down');
  reconnector.reset('interviewer');

  const health = reconnector.getProviderHealth('interviewer');
  assert.equal(health.state, 'healthy');
  assert.equal(health.retryCount, 0);
  assert.equal(health.cooldownRemainingMs, 0);

  // With a healthy reset state, a new error should trigger a reconnect attempt again.
  let reconnects = 0;
  const reconnector2 = new STTReconnector(
    async () => {
      reconnects += 1;
    },
    { baseDelayMs: 1 },
  );
  reconnector2.onError('interviewer');
  await wait(10);
  assert.equal(reconnects, 1);
});

test('STTReconnector stopAll cancels queued reconnect timers and clears health', async () => {
  let reconnects = 0;
  const reconnector = new STTReconnector(
    async () => {
      reconnects += 1;
    },
    { baseDelayMs: 25 },
  );

  reconnector.onError('interviewer');
  reconnector.stopAll();
  await wait(40);

  assert.equal(reconnects, 0);
  assert.equal(reconnector.getProviderHealth('interviewer').state, 'healthy');
  assert.equal(reconnector.getProviderHealth('user').state, 'healthy');
});

test('STTReconnector enforces default reconnect storm bound of max 3 attempts per error burst', async () => {
  let reconnectAttempts = 0;
  const reconnector = new STTReconnector(
    async () => {
      reconnectAttempts += 1;
      throw new Error('boom');
    },
    { baseDelayMs: 1, cooldownMs: 40 },
  );

  reconnector.onError('user');
  await wait(20);

  // Default maxRetries is 3.
  assert.equal(reconnectAttempts, 3);
  assert.equal(reconnector.getProviderHealth('user').state, 'down');
});
