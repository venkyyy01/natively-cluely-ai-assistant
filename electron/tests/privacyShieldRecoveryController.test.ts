import test from 'node:test';
import assert from 'node:assert/strict';

import { PrivacyShieldRecoveryController } from '../stealth/PrivacyShieldRecoveryController';
import type { StealthState } from '../runtime/types';

type RecoverySnapshot = {
  isUndetectable: boolean;
  faultReason: string | null;
  warnings: string[];
  stealthState: StealthState;
};

function createHarness(overrides: Partial<RecoverySnapshot> = {}, options: { maxAutoRecoveryAttempts?: number } = {}) {
  let state: RecoverySnapshot = {
    isUndetectable: true,
    faultReason: 'window_visible_to_capture',
    warnings: [],
    stealthState: 'FAULT',
    ...overrides,
  };

  const scheduled: Array<() => void> = [];
  const cleared: number[] = [];
  const recoverCalls: string[] = [];

  const controller = new PrivacyShieldRecoveryController({
    getSnapshot: () => state,
    recoverFullStealth: async () => {
      recoverCalls.push('recover');
    },
    recoveryDelayMs: 25,
    maxAutoRecoveryAttempts: options.maxAutoRecoveryAttempts,
    timeoutScheduler: (callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length - 1;
    },
    clearTimeoutScheduler: (handle: unknown) => {
      cleared.push(handle as number);
    },
    logger: { log() {}, warn() {} },
  });

  return {
    controller,
    get state() {
      return state;
    },
    setState(next: Partial<RecoverySnapshot>) {
      state = { ...state, ...next };
    },
    scheduled,
    cleared,
    recoverCalls,
  };
}

test('PrivacyShieldRecoveryController waits for capture-risk warnings to clear before scheduling auto-recovery', async () => {
  const harness = createHarness({ warnings: ['window_visible_to_capture'] });

  harness.controller.update();
  assert.equal(harness.scheduled.length, 0);

  harness.setState({ warnings: [] });
  harness.controller.update();
  assert.equal(harness.scheduled.length, 1);

  await harness.scheduled[0]?.();

  assert.deepEqual(harness.recoverCalls, ['recover']);
});

test('PrivacyShieldRecoveryController only performs manual recovery when full stealth can be safely restored', async () => {
  const harness = createHarness({ warnings: ['chromium_capture_active'] });

  assert.equal(await harness.controller.triggerManualRecovery(), false);
  assert.deepEqual(harness.recoverCalls, []);

  harness.setState({ warnings: [] });
  assert.equal(await harness.controller.triggerManualRecovery(), true);
  assert.deepEqual(harness.recoverCalls, ['recover']);
});

test('PrivacyShieldRecoveryController cancels pending auto-recovery once full stealth is restored', () => {
  const harness = createHarness();

  harness.controller.update();
  assert.equal(harness.scheduled.length, 1);

  harness.setState({ stealthState: 'FULL_STEALTH', faultReason: null });
  harness.controller.update();

  assert.deepEqual(harness.cleared, [0]);
});

test('PrivacyShieldRecoveryController caps auto-recovery retries to avoid runaway fault loops', async () => {
  const harness = createHarness({}, { maxAutoRecoveryAttempts: 2 });

  harness.controller.update();
  await harness.scheduled[0]?.();
  assert.equal(harness.scheduled.length, 2);

  await harness.scheduled[1]?.();
  assert.equal(harness.scheduled.length, 2);
  assert.deepEqual(harness.recoverCalls, ['recover', 'recover']);
});
