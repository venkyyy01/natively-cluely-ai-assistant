import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppleSiliconQoS } from '../runtime/AppleSiliconQoS';

test('AppleSiliconQoS uses the native helper on darwin arm64 when it loads', () => {
  const calls: string[] = [];
  const qos = createAppleSiliconQoS({
    platform: 'darwin',
    arch: 'arm64',
    addonLoader: () => ({
      setCurrentThreadQoS(qosClass) {
        calls.push(qosClass);
      },
    }),
    logger: { warn() {} },
  });

  assert.equal(qos.supported, true);
  qos.setCurrentThreadQoS('USER_INTERACTIVE');
  assert.deepEqual(calls, ['USER_INTERACTIVE']);
});

test('AppleSiliconQoS falls back to a no-op handle when the addon is unavailable', () => {
  const qos = createAppleSiliconQoS({
    platform: 'darwin',
    arch: 'arm64',
    addonLoader: () => {
      throw new Error('missing addon');
    },
    logger: { warn() {} },
  });

  assert.equal(qos.supported, false);
  assert.doesNotThrow(() => qos.setCurrentThreadQoS('BACKGROUND'));
});
