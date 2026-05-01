import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';
import { WorkerPool } from '../runtime/WorkerPool';

test('RuntimeBudgetScheduler prioritizes realtime work ahead of queued background work', async () => {
  const scheduler = new RuntimeBudgetScheduler({
    workerPool: new WorkerPool({
      size: 1,
      qos: { supported: false, setCurrentThreadQoS() {} },
      logger: { warn() {} },
    }),
    logger: { warn() {} },
  });

  let releaseFirst: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];

  const first = scheduler.submit('background', async () => {
    order.push('background-1:start');
    await firstGate;
    order.push('background-1:end');
  });
  const second = scheduler.submit('background', async () => {
    order.push('background-2');
  });
  const third = scheduler.submit('realtime', async () => {
    order.push('realtime');
  });

  releaseFirst?.();
  await Promise.all([first, second, third]);

  assert.deepEqual(order, ['background-1:start', 'background-1:end', 'realtime', 'background-2']);
});

test('RuntimeBudgetScheduler emits critical pressure and sheds queued background work', async () => {
  const bus = new SupervisorBus({ error() {} });
  const pressures: string[] = [];
  bus.subscribe('budget:pressure', async (event) => {
    pressures.push(`${event.lane}:${event.level}`);
  });

  const scheduler = new RuntimeBudgetScheduler({
    bus,
    laneBudgets: {
      realtime: { deadlineMs: 20, maxConcurrent: 1, memoryCeilingMb: 10 },
      background: { deadlineMs: 20, maxConcurrent: 1, memoryCeilingMb: 10 },
    },
    memoryUsageReader: () => currentMemory,
    logger: { warn() {} },
  });
  let currentMemory = 6 * 1024 * 1024;

  let releaseRealtime: (() => void) | null = null;
  const realtimeGate = new Promise<void>((resolve) => {
    releaseRealtime = resolve;
  });

  const background = scheduler.submit('background', async () => 'background');
  currentMemory = 9 * 1024 * 1024;
  const realtime = scheduler.submit('realtime', async () => {
    await realtimeGate;
    return 'realtime';
  });
  const shed = scheduler.submit('background', async () => 'should-shed');

  releaseRealtime?.();
  await background;
  await realtime;
  await assert.rejects(() => shed, /background work shed due to critical pressure on realtime/);
  assert.ok(pressures.includes('realtime:critical'));
});
