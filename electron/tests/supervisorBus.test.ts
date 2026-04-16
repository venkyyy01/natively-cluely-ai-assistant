import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';

test('SupervisorBus delivers listeners in registration order and supports subscribeAll', async () => {
  const bus = new SupervisorBus({ error() {} });
  const seen: string[] = [];

  bus.subscribe('audio:capture-started', async () => {
    seen.push('first');
  });
  bus.subscribe('audio:capture-started', async () => {
    seen.push('second');
  });
  bus.subscribeAll(async (event) => {
    seen.push(`all:${event.type}`);
  });

  await bus.emit({ type: 'audio:capture-started' });

  assert.deepEqual(seen, ['first', 'second', 'all:audio:capture-started']);
});

test('SupervisorBus isolates listener failures', async () => {
  const errors: string[] = [];
  const bus = new SupervisorBus({
    error(message) {
      errors.push(String(message));
    },
  });
  const seen: string[] = [];

  bus.subscribe('lifecycle:meeting-idle', async () => {
    seen.push('before-error');
  });
  bus.subscribe('lifecycle:meeting-idle', async () => {
    throw new Error('boom');
  });
  bus.subscribe('lifecycle:meeting-idle', async () => {
    seen.push('after-error');
  });

  await bus.emit({ type: 'lifecycle:meeting-idle' });

  assert.deepEqual(seen, ['before-error', 'after-error']);
  assert.equal(errors.length, 1);
});

test('SupervisorBus emits a bus:listener-error meta event for non-critical listener failures', async () => {
  const bus = new SupervisorBus({ error() {} });
  const metaEvents: Array<{
    sourceEventType: string;
    failureCount: number;
    messages: string[];
    critical: boolean;
  }> = [];

  bus.subscribe('bus:listener-error', async (event) => {
    metaEvents.push({
      sourceEventType: event.sourceEventType,
      failureCount: event.failureCount,
      messages: event.messages,
      critical: event.critical,
    });
  });
  bus.subscribe('lifecycle:meeting-idle', async () => {
    throw new Error('boom');
  });

  await bus.emit({ type: 'lifecycle:meeting-idle' });

  assert.deepEqual(metaEvents, [{
    sourceEventType: 'lifecycle:meeting-idle',
    failureCount: 1,
    messages: ['boom'],
    critical: false,
  }]);
});

test('SupervisorBus rethrows listener failures for critical events after notifying all listeners', async () => {
  const errors: string[] = [];
  const bus = new SupervisorBus({
    error(message) {
      errors.push(String(message));
    },
  });
  const seen: string[] = [];

  bus.subscribe('stealth:fault', async () => {
    seen.push('before-error');
  });
  bus.subscribe('stealth:fault', async () => {
    throw new Error('boom');
  });
  bus.subscribe('stealth:fault', async () => {
    seen.push('after-error');
  });
  const metaEvents: Array<{ sourceEventType: string; failureCount: number; critical: boolean }> = [];
  bus.subscribe('bus:listener-error', async (event) => {
    metaEvents.push({
      sourceEventType: event.sourceEventType,
      failureCount: event.failureCount,
      critical: event.critical,
    });
  });

  await assert.rejects(
    () => bus.emit({ type: 'stealth:fault', reason: 'capture detected' }),
    /Critical SupervisorBus event "stealth:fault" had listener failures: boom/,
  );

  assert.deepEqual(seen, ['before-error', 'after-error']);
  assert.equal(errors.length, 1);
  assert.deepEqual(metaEvents, [{ sourceEventType: 'stealth:fault', failureCount: 1, critical: true }]);
});

test('SupervisorBus unsubscribe removes the listener', async () => {
  const bus = new SupervisorBus({ error() {} });
  let calls = 0;

  const unsubscribe = bus.subscribe('lifecycle:meeting-stopping', async () => {
    calls += 1;
  });

  await bus.emit({ type: 'lifecycle:meeting-stopping' });
  unsubscribe();
  await bus.emit({ type: 'lifecycle:meeting-stopping' });

  assert.equal(calls, 1);
});
