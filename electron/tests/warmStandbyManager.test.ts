import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { WarmStandbyManager } from '../runtime/WarmStandbyManager';

test('WarmStandbyManager warms, binds, unbinds, and cools reusable resources', async () => {
  const calls: string[] = [];
  const manager = new WarmStandbyManager({
    audio: {
      async warmUp() {
        calls.push('audio:warm');
        return { id: 'audio' };
      },
      async coolDown() {
        calls.push('audio:cool');
      },
      checkHealth: () => true,
    },
    stt: {
      async warmUp() {
        calls.push('stt:warm');
        return { id: 'stt' };
      },
      async coolDown() {
        calls.push('stt:cool');
      },
      checkHealth: () => true,
    },
    workerPool: {
      async warmUp() {
        calls.push('worker:warm');
        return { id: 'worker' };
      },
      async coolDown() {
        calls.push('worker:cool');
      },
      checkHealth: () => true,
    },
    logger: { warn() {} },
  });

  const initialHealth = await manager.warmUp();
  assert.equal(initialHealth.ready, true);
  assert.equal(initialHealth.workerPool.ready, true);

  await manager.bindMeeting('meeting-1');
  assert.equal(manager.getState(), 'bound');

  await manager.unbindMeeting();
  assert.equal(manager.getState(), 'ready');

  await manager.coolDown();
  assert.equal(manager.getState(), 'idle');
  assert.deepEqual(calls, [
    'audio:warm',
    'stt:warm',
    'worker:warm',
    'worker:cool',
    'stt:cool',
    'audio:cool',
  ]);
});

test('WarmStandbyManager defers background worker warmup under critical pressure until resumed', async () => {
  const bus = new SupervisorBus({ error() {} });
  const calls: string[] = [];
  const manager = new WarmStandbyManager({
    bus,
    audio: {
      async warmUp() {
        calls.push('audio:warm');
        return { id: 'audio' };
      },
      checkHealth: () => true,
    },
    stt: {
      async warmUp() {
        calls.push('stt:warm');
        return { id: 'stt' };
      },
      checkHealth: () => true,
    },
    workerPool: {
      async warmUp() {
        calls.push('worker:warm');
        return { id: 'worker' };
      },
      checkHealth: () => true,
    },
    logger: { warn() {} },
  });

  await bus.emit({ type: 'budget:pressure', lane: 'background', level: 'critical' });
  const deferredHealth = await manager.warmUp();
  assert.equal(deferredHealth.deferredBackgroundWarmup, true);
  assert.equal(deferredHealth.workerPool.ready, false);

  const resumedHealth = await manager.resumeDeferredWarmup();
  assert.equal(resumedHealth.workerPool.ready, true);
  assert.deepEqual(calls, ['audio:warm', 'stt:warm', 'worker:warm']);
});
