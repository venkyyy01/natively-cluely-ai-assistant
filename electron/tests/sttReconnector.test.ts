import test from 'node:test';
import assert from 'node:assert/strict';

import { STTReconnector } from '../STTReconnector';

test('STTReconnector waits for three errors before reconnecting', async () => {
  let reconnects = 0;
  const reconnector = new STTReconnector(async () => {
    reconnects += 1;
  });
  const internal = reconnector as unknown as { baseDelayMs: number };
  internal.baseDelayMs = 1;

  reconnector.onError('interviewer');
  reconnector.onError('interviewer');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(reconnects, 0);

  reconnector.onError('interviewer');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reconnects, 1);
});

test('STTReconnector emits reconnect lifecycle events', async () => {
  const events: string[] = [];
  const reconnector = new STTReconnector(async () => {});
  const internal = reconnector as unknown as { baseDelayMs: number };
  internal.baseDelayMs = 1;

  reconnector.on('reconnecting', ({ speaker }) => {
    events.push(`reconnecting:${speaker}`);
  });
  reconnector.on('reconnected', ({ speaker }) => {
    events.push(`reconnected:${speaker}`);
  });

  reconnector.onError('user');
  reconnector.onError('user');
  reconnector.onError('user');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(events, ['reconnecting:user', 'reconnected:user']);
});

test('STTReconnector emits exhausted after max retries fail', async () => {
  const events: string[] = [];
  const reconnector = new STTReconnector(async () => {
    throw new Error('boom');
  });
  const internal = reconnector as unknown as { baseDelayMs: number; maxRetries: number };
  internal.baseDelayMs = 1;
  internal.maxRetries = 1;

  reconnector.on('exhausted', ({ speaker }) => {
    events.push(speaker);
  });

  reconnector.onError('interviewer');
  reconnector.onError('interviewer');
  reconnector.onError('interviewer');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(events, ['interviewer']);
});
