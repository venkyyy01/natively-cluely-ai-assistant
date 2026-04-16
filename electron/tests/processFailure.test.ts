import test from 'node:test';
import assert from 'node:assert/strict';

import { exitAfterCriticalFailure } from '../processFailure';

test('exitAfterCriticalFailure exits with the standard code when logging settles', async () => {
  const exitCodes: number[] = [];
  const clearedHandles: unknown[] = [];
  const timerHandle = {
    unrefCalled: false,
    unref() {
      this.unrefCalled = true;
    },
  };
  let resolveLog!: () => void;
  const logAttempt = new Promise<void>((resolve) => {
    resolveLog = resolve;
  });

  const pending = exitAfterCriticalFailure(logAttempt, {
    exit: (code) => {
      exitCodes.push(code);
    },
    scheduleTimeout: ((() => timerHandle as unknown as NodeJS.Timeout) as unknown as typeof setTimeout),
    clearScheduledTimeout: (handle) => {
      clearedHandles.push(handle);
    },
  });

  resolveLog();
  await pending;

  assert.deepEqual(exitCodes, [1]);
  assert.deepEqual(clearedHandles, [timerHandle]);
  assert.equal(timerHandle.unrefCalled, true);
});

test('exitAfterCriticalFailure forces a fallback exit code when logging never settles', async () => {
  const exitCodes: number[] = [];
  let timeoutCallback: (() => void) | undefined;

  void exitAfterCriticalFailure(new Promise<void>(() => {}), {
    exit: (code) => {
      exitCodes.push(code);
    },
    scheduleTimeout: (((callback: () => void) => {
      timeoutCallback = callback;
      return { unref() {} } as NodeJS.Timeout;
    }) as typeof setTimeout),
    clearScheduledTimeout: () => {
      assert.fail('clearScheduledTimeout should not run for a hung log attempt');
    },
  });

  assert.equal(typeof timeoutCallback, 'function');
  timeoutCallback?.();

  assert.deepEqual(exitCodes, [2]);
});
