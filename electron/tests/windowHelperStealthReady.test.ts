import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the stealthReadyPromise gate in WindowHelper.
 *
 * Since WindowHelper has heavy Electron dependencies (BrowserWindow, screen, app),
 * we test the gate logic in isolation by extracting the pattern and verifying
 * the behavior of markStealthReady / waitForStealthReady / timeout.
 */

// Minimal mock of StealthManager with isEnabled()
function createMockStealthManager(enabled: boolean) {
  return {
    isEnabled: () => enabled,
    applyInitialStealth: () => {},
    applyToWindow: () => {},
    reapplyAfterShow: () => {},
    reapplyProtectionLayers: () => {},
    recordProtectionEvent: () => {},
  };
}

/**
 * Replicate the stealthReadyPromise gate logic from WindowHelper for isolated testing.
 * This avoids needing to mock the entire Electron environment.
 */
function createStealthReadyGate(stealthEnabled: boolean, timeoutMs = 5000) {
  let stealthReadyResolve: (() => void) | null = null;
  let stealthReadyPromise: Promise<void>;
  let timedOut = false;

  if (!stealthEnabled) {
    stealthReadyPromise = Promise.resolve();
  } else {
    stealthReadyPromise = new Promise<void>((resolve) => {
      stealthReadyResolve = resolve;
    });

    setTimeout(() => {
      if (stealthReadyResolve) {
        timedOut = true;
        stealthReadyResolve();
        stealthReadyResolve = null;
      }
    }, timeoutMs);
  }

  return {
    waitForStealthReady: () => stealthReadyPromise,
    markStealthReady: () => {
      if (stealthReadyResolve) {
        stealthReadyResolve();
        stealthReadyResolve = null;
      }
    },
    didTimeout: () => timedOut,
  };
}

test('stealthReadyPromise resolves immediately when stealth is disabled', async () => {
  const gate = createStealthReadyGate(false);

  // Should resolve immediately without needing markStealthReady
  let resolved = false;
  gate.waitForStealthReady().then(() => { resolved = true; });

  // Allow microtask to run
  await Promise.resolve();
  assert.equal(resolved, true, 'Promise should resolve immediately when stealth is disabled');
});

test('stealthReadyPromise does not resolve until markStealthReady is called', async () => {
  const gate = createStealthReadyGate(true, 60000); // long timeout so it doesn't interfere

  let resolved = false;
  gate.waitForStealthReady().then(() => { resolved = true; });

  // Allow microtask to run
  await Promise.resolve();
  assert.equal(resolved, false, 'Promise should NOT resolve before markStealthReady is called');

  // Now mark ready
  gate.markStealthReady();
  await Promise.resolve();
  assert.equal(resolved, true, 'Promise should resolve after markStealthReady is called');
});

test('stealthReadyPromise resolves on timeout when markStealthReady is never called', async () => {
  // Use a very short timeout for testing
  const gate = createStealthReadyGate(true, 50);

  let resolved = false;
  gate.waitForStealthReady().then(() => { resolved = true; });

  // Should not be resolved yet
  await Promise.resolve();
  assert.equal(resolved, false, 'Promise should NOT resolve before timeout');

  // Wait for the timeout to fire
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(resolved, true, 'Promise should resolve after timeout');
  assert.equal(gate.didTimeout(), true, 'Should indicate timeout occurred');
});

test('markStealthReady is idempotent — calling it multiple times does not throw', () => {
  const gate = createStealthReadyGate(true, 60000);

  // Should not throw when called multiple times
  gate.markStealthReady();
  gate.markStealthReady();
  gate.markStealthReady();
});

test('markStealthReady before timeout prevents timeout from resolving again', async () => {
  const gate = createStealthReadyGate(true, 50);

  let resolveCount = 0;
  gate.waitForStealthReady().then(() => { resolveCount++; });

  // Mark ready before timeout
  gate.markStealthReady();
  await Promise.resolve();
  assert.equal(resolveCount, 1, 'Promise should resolve once after markStealthReady');

  // Wait past the timeout
  await new Promise((r) => setTimeout(r, 100));
  // Promise only resolves once regardless
  assert.equal(resolveCount, 1, 'Promise should still only have resolved once');
  assert.equal(gate.didTimeout(), false, 'Should NOT indicate timeout since markStealthReady was called first');
});

test('waitForStealthReady returns the same promise on multiple calls', async () => {
  const gate = createStealthReadyGate(true, 60000);

  const p1 = gate.waitForStealthReady();
  const p2 = gate.waitForStealthReady();
  assert.strictEqual(p1, p2, 'waitForStealthReady should return the same promise instance');
});
