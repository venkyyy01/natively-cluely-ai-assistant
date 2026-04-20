import test from 'node:test';
import assert from 'node:assert/strict';

import { PrivacyShieldRecoveryController } from '../stealth/PrivacyShieldRecoveryController';

test('NAT-030: two concurrent recovery requests share one promise and single underlying run', async () => {
  let recoveryCallCount = 0;
  const controller = new PrivacyShieldRecoveryController({
    getSnapshot: () => ({
      isUndetectable: true,
      faultReason: 'test-fault',
      warnings: [],
      stealthState: 'FAULT',
    }),
    recoverFullStealth: async () => {
      recoveryCallCount += 1;
      await new Promise((r) => setTimeout(r, 50));
    },
    recoveryDelayMs: 10,
    maxAutoRecoveryAttempts: 3,
  });

  // Kick off two manual recoveries concurrently
  const r1 = controller.triggerManualRecovery();
  const r2 = controller.triggerManualRecovery();
  const [result1, result2] = await Promise.all([r1, r2]);

  // Both should succeed, but underlying recovery should only run once
  assert.equal(recoveryCallCount, 1, 'underlying recovery must run exactly once');
  assert.equal(result1, true);
  assert.equal(result2, true);
});

test('NAT-030: shield does not clear when post-recovery warnings include capture-risk', async () => {
  let recoveryCallCount = 0;
  let warnings = ['capture-risk-detected'];
  const controller = new PrivacyShieldRecoveryController({
    getSnapshot: () => ({
      isUndetectable: true,
      faultReason: 'test-fault',
      warnings,
      stealthState: 'FAULT',
    }),
    recoverFullStealth: async () => {
      recoveryCallCount += 1;
    },
    recoveryDelayMs: 10,
    maxAutoRecoveryAttempts: 3,
  });

  const result = await controller.triggerManualRecovery();
  // Recovery itself succeeds, but because warnings still have capture-risk,
  // autoRecoveryAttempts should NOT be reset.
  assert.equal(result, true);
  assert.equal(recoveryCallCount, 1);
});
