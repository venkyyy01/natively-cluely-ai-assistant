import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { RecoverySupervisor } from '../runtime/RecoverySupervisor';

test('RecoverySupervisor checkpoints and restores through the delegate and emits bus events', async () => {
  const calls: string[] = [];
  const bus = new SupervisorBus({ error() {} });
  const events: string[] = [];

  bus.subscribeAll(async (event) => {
    events.push(event.type);
  });

  const supervisor = new RecoverySupervisor({
    bus,
    delegate: {
      async start() {
        calls.push('start');
      },
      async stop() {
        calls.push('stop');
      },
      async checkpoint(checkpointId) {
        calls.push(`checkpoint:${checkpointId}`);
      },
      async restore(sessionId) {
        calls.push(`restore:${sessionId}`);
      },
    },
  });

  await supervisor.start();
  await supervisor.checkpoint('checkpoint-1');
  await supervisor.restore('session-1');
  await supervisor.stop();

  assert.equal(supervisor.getState(), 'idle');
  assert.deepEqual(calls, ['start', 'checkpoint:checkpoint-1', 'restore:session-1', 'stop']);
  assert.deepEqual(events, [
    'recovery:checkpoint-written',
    'recovery:restore-complete',
  ]);
});

test('RecoverySupervisor transitions to faulted on start failure', async () => {
  const supervisor = new RecoverySupervisor({
    delegate: {
      async start() {
        throw new Error('recovery start failed');
      },
    },
  });

  await assert.rejects(() => supervisor.start(), /recovery start failed/);
  assert.equal(supervisor.getState(), 'faulted');
});

test('RecoverySupervisor emits checkpoint and restore events only after delegate success', async () => {
  const events: string[] = [];
  const bus = new SupervisorBus({ error() {} });
  const supervisor = new RecoverySupervisor({
    bus,
    delegate: {
      async checkpoint() {
        events.push('checkpoint-call');
      },
      async restore() {
        events.push('restore-call');
      },
    },
  });

  bus.subscribeAll(async (event) => {
    events.push(event.type);
  });

  await supervisor.checkpoint('checkpoint-2');
  await supervisor.restore('session-2');

  assert.deepEqual(events, [
    'checkpoint-call',
    'recovery:checkpoint-written',
    'restore-call',
    'recovery:restore-complete',
  ]);
});
