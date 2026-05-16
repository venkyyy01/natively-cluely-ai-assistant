import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkerPool } from '../runtime/WorkerPool';

test('WorkerPool exposes queue depth, saturation, and respects priority after active work drains', async () => {
  const qosCalls: string[] = [];
  const pool = new WorkerPool({
    size: 1,
    qos: {
      supported: true,
      setCurrentThreadQoS(qosClass) {
        qosCalls.push(qosClass);
      },
    },
    logger: { warn() {} },
  });

  let releaseFirst: (() => void) | null = null;
  const first = new Promise<string>((resolve) => {
    releaseFirst = () => resolve('first');
  });
  const order: string[] = [];

  const taskOne = pool.submit({ lane: 'background', priority: 1 }, async () => {
    order.push('task-1:start');
    return first;
  }).then((value) => {
    order.push(`task-1:${value}`);
  });

  const taskTwo = pool.submit({ lane: 'background', priority: 1 }, async () => {
    order.push('task-2');
    return 'two';
  });
  const taskThree = pool.submit({ lane: 'realtime', priority: 5 }, async () => {
    order.push('task-3');
    return 'three';
  });

  assert.equal(pool.getStats().queueDepth, 2);
  assert.equal(pool.getStats().saturation, 1);

  releaseFirst?.();
  await Promise.all([taskOne, taskTwo, taskThree]);

  assert.deepEqual(order, ['task-1:start', 'task-1:first', 'task-3', 'task-2']);
  assert.deepEqual(qosCalls, ['BACKGROUND', 'USER_INTERACTIVE', 'BACKGROUND']);
});
