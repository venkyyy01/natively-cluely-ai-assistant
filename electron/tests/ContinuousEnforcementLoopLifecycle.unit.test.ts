/**
 * Unit tests for ContinuousEnforcementLoop lifecycle and kill switch.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5
 *
 * Tests:
 * - Start-on-enable, stop-on-disable
 * - Stop on before-quit
 * - Non-strict mode hides windows and warns
 * - Strict mode quits app
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ContinuousEnforcementLoop } from '../stealth/ContinuousEnforcementLoop';

// --- Silent logger to suppress output during tests ---
const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

// --- Mock Factories ---

function createMockStealthManager() {
  const hiddenWindows: number[] = [];
  return {
    reapplyProtectionLayers() {},
    pollCaptureTools() {},
    isMacOS15PlusCapable() {
      return false;
    },
    getManagedWindowNumbers() {
      return [
        { windowNumber: 1, win: { id: 1 } },
        { windowNumber: 2, win: { id: 2 } },
      ];
    },
    requestWindowHide(win: unknown, _opts: unknown) {
      hiddenWindows.push((win as { id: number }).id);
    },
    triggerEmergencyProtection() {},
    isEnabled() {
      return true;
    },
    getHiddenWindows() {
      return hiddenWindows;
    },
  };
}

function createMockMonitoringDetector() {
  return {
    async detect(): Promise<never[]> {
      return [];
    },
  };
}

function createMockBus() {
  const emittedEvents: Array<{ type: string; reason?: string }> = [];
  return {
    async emit(event: { type: string; reason?: string }) {
      emittedEvents.push(event);
    },
    getEmittedEvents() {
      return emittedEvents;
    },
  };
}

function createDefaultIntervals() {
  return {
    windowProtectionMs: 100_000, // Long intervals to prevent timers from firing during tests
    processDetectionMs: 100_000,
    disguiseValidationMs: 100_000,
  };
}

// --- Requirement 2.1: Start on enable ---

test('enforcement loop starts when start() is called (simulates stealth enable)', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  assert.equal(loop.isRunning(), false, 'should not be running initially');
  loop.start();
  assert.equal(loop.isRunning(), true, 'should be running after start()');
  loop.stop();
});

test('start() is idempotent — calling it twice does not double-start', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  loop.start();
  loop.start(); // second call should be no-op
  assert.equal(loop.isRunning(), true);
  loop.stop();
  assert.equal(loop.isRunning(), false);
});

// --- Requirement 2.2: Stop on disable ---

test('enforcement loop stops when stop() is called (simulates stealth disable)', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  loop.start();
  assert.equal(loop.isRunning(), true);
  loop.stop();
  assert.equal(loop.isRunning(), false, 'should not be running after stop()');
});

test('stop() is idempotent — calling it twice does not error', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  loop.start();
  loop.stop();
  loop.stop(); // second call should be no-op
  assert.equal(loop.isRunning(), false);
});

// --- Requirement 2.3: Stop on before-quit ---

test('enforcement loop can be stopped to simulate before-quit cleanup', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  loop.start();
  assert.equal(loop.isRunning(), true);

  // Simulate before-quit: stop the loop
  loop.stop();
  assert.equal(loop.isRunning(), false, 'loop should be stopped on before-quit');
});

test('stop after start clears all internal timers (no lingering timers)', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  loop.start();
  loop.stop();

  // Verify the loop can be restarted cleanly (proves timers were cleared)
  loop.start();
  assert.equal(loop.isRunning(), true);
  loop.stop();
});

// --- Requirement 2.4: Non-strict mode hides windows and warns ---

test('kill switch in non-strict mode calls hideAllWindows', async () => {
  let hideAllCalled = false;

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => { hideAllCalled = true; },
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  await loop.triggerKillSwitch('test-reason');

  assert.equal(hideAllCalled, true, 'hideAllWindows should be called in non-strict mode');
  loop.stop();
});

test('kill switch in non-strict mode calls showWarning with reason', async () => {
  let warningReason = '';

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => {},
      showWarning: (reason: string) => { warningReason = reason; },
      quit: () => {},
    },
  });

  loop.start();
  await loop.triggerKillSwitch('monitoring-tool-detected:Teramind');

  assert.equal(warningReason, 'monitoring-tool-detected:Teramind', 'showWarning should receive the reason');
  loop.stop();
});

test('kill switch in non-strict mode emits stealth:fault event', async () => {
  const bus = createMockBus();

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: bus as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  await loop.triggerKillSwitch('test-fault');

  const faultEvents = bus.getEmittedEvents().filter(e => e.type === 'stealth:fault');
  assert.equal(faultEvents.length, 1, 'should emit exactly one stealth:fault event');
  assert.equal(faultEvents[0].reason, 'test-fault', 'stealth:fault should include the reason');
  loop.stop();
});

test('warning screen-capture threats reapply protection without emitting stealth fault', async () => {
  const bus = createMockBus();
  let pollCaptureToolsCalled = 0;
  const stealthManager = {
    ...createMockStealthManager(),
    pollCaptureTools() {
      pollCaptureToolsCalled += 1;
    },
  };

  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: bus as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  await (loop as any).handleWarningThreat({
    name: 'Zoom',
    pid: '123',
    category: 'screen-capture',
    severity: 'warning',
  });

  assert.equal(pollCaptureToolsCalled, 1);
  assert.equal(bus.getEmittedEvents().filter(e => e.type === 'stealth:fault').length, 0);
});

test('kill switch in non-strict mode does NOT call quit', async () => {
  let quitCalled = false;

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => { quitCalled = true; },
    },
  });

  loop.start();
  await loop.triggerKillSwitch('test-reason');

  assert.equal(quitCalled, false, 'quit should NOT be called in non-strict mode');
  loop.stop();
});

test('kill switch in non-strict mode increments enforcement epoch', async () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  assert.equal(loop.getEnforcementEpoch(), 0, 'epoch starts at 0');

  await loop.triggerKillSwitch('reason-1');
  assert.equal(loop.getEnforcementEpoch(), 1, 'epoch incremented after first kill switch');

  await loop.triggerKillSwitch('reason-2');
  assert.equal(loop.getEnforcementEpoch(), 2, 'epoch incremented after second kill switch');
  loop.stop();
});

// --- Requirement 2.5: Strict mode quits app ---

test('kill switch in strict mode calls quit with code 1 and reason', async () => {
  let quitCode: number | null = null;
  let quitReason: string | null = null;

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: true,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: (code: number, reason: string) => {
        quitCode = code;
        quitReason = reason;
      },
    },
  });

  loop.start();
  await loop.triggerKillSwitch('critical-violation');

  assert.equal(quitCode, 1, 'quit should be called with exit code 1');
  assert.equal(quitReason, 'critical-violation', 'quit should receive the reason');
  loop.stop();
});

test('kill switch in strict mode does NOT call hideAllWindows', async () => {
  let hideAllCalled = false;

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: true,
      hideAllWindows: () => { hideAllCalled = true; },
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  await loop.triggerKillSwitch('test-reason');

  assert.equal(hideAllCalled, false, 'hideAllWindows should NOT be called in strict mode');
  loop.stop();
});

test('kill switch in strict mode does NOT call showWarning', async () => {
  let warningCalled = false;

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: true,
      hideAllWindows: () => {},
      showWarning: () => { warningCalled = true; },
      quit: () => {},
    },
  });

  loop.start();
  await loop.triggerKillSwitch('test-reason');

  assert.equal(warningCalled, false, 'showWarning should NOT be called in strict mode');
  loop.stop();
});

test('kill switch in strict mode does NOT emit stealth:fault event', async () => {
  const bus = createMockBus();

  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: bus as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: true,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  await loop.triggerKillSwitch('test-reason');

  const faultEvents = bus.getEmittedEvents().filter(e => e.type === 'stealth:fault');
  assert.equal(faultEvents.length, 0, 'no stealth:fault event in strict mode');
  loop.stop();
});

test('kill switch in strict mode does NOT increment enforcement epoch', async () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: true,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  assert.equal(loop.getEnforcementEpoch(), 0);

  await loop.triggerKillSwitch('test-reason');
  assert.equal(loop.getEnforcementEpoch(), 0, 'epoch should not change in strict mode');
  loop.stop();
});

// --- shouldSuppressShow behavior ---

test('shouldSuppressShow returns false when no kill switch has fired', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => {},
    },
  });

  // showEpoch 0 vs enforcementEpoch 0 → not suppressed
  assert.equal(loop.shouldSuppressShow(0), false);
});

test('shouldSuppressShow returns true when kill switch has fired after show epoch', async () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  const showEpoch = loop.getEnforcementEpoch(); // 0
  await loop.triggerKillSwitch('test-reason');

  // enforcementEpoch is now 1, showEpoch is 0 → suppress
  assert.equal(loop.shouldSuppressShow(showEpoch), true);
  loop.stop();
});

test('shouldSuppressShow returns false when show epoch matches enforcement epoch', async () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
    killSwitch: {
      strictMode: false,
      hideAllWindows: () => {},
      showWarning: () => {},
      quit: () => {},
    },
  });

  loop.start();
  await loop.triggerKillSwitch('test-reason');
  const showEpoch = loop.getEnforcementEpoch(); // 1

  // showEpoch equals enforcementEpoch → not suppressed
  assert.equal(loop.shouldSuppressShow(showEpoch), false);
  loop.stop();
});

// --- Default kill switch behavior (environment-driven) ---

test('kill switch defaults to non-strict when NATIVELY_STRICT_KILL_SWITCH is not set', async () => {
  const originalEnv = process.env.NATIVELY_STRICT_KILL_SWITCH;
  delete process.env.NATIVELY_STRICT_KILL_SWITCH;

  try {
    let hideAllCalled = false;

    const loop = new ContinuousEnforcementLoop({
      stealthManager: createMockStealthManager() as never,
      monitoringDetector: createMockMonitoringDetector() as never,
      bus: createMockBus() as never,
      intervals: createDefaultIntervals(),
      logger: silentLogger,
      killSwitch: {
        hideAllWindows: () => { hideAllCalled = true; },
        showWarning: () => {},
        quit: () => {},
      },
    });

    loop.start();
    await loop.triggerKillSwitch('test-reason');

    assert.equal(hideAllCalled, true, 'should default to non-strict (hide windows)');
    loop.stop();
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_STRICT_KILL_SWITCH = originalEnv;
    }
  }
});

test('kill switch defaults to strict when NATIVELY_STRICT_KILL_SWITCH=1', async () => {
  const originalEnv = process.env.NATIVELY_STRICT_KILL_SWITCH;
  process.env.NATIVELY_STRICT_KILL_SWITCH = '1';

  try {
    let quitCalled = false;

    const loop = new ContinuousEnforcementLoop({
      stealthManager: createMockStealthManager() as never,
      monitoringDetector: createMockMonitoringDetector() as never,
      bus: createMockBus() as never,
      intervals: createDefaultIntervals(),
      logger: silentLogger,
      killSwitch: {
        hideAllWindows: () => {},
        showWarning: () => {},
        quit: () => { quitCalled = true; },
      },
    });

    loop.start();
    await loop.triggerKillSwitch('test-reason');

    assert.equal(quitCalled, true, 'should use strict mode when env var is set');
    loop.stop();
  } finally {
    if (originalEnv !== undefined) {
      process.env.NATIVELY_STRICT_KILL_SWITCH = originalEnv;
    } else {
      delete process.env.NATIVELY_STRICT_KILL_SWITCH;
    }
  }
});

// --- Lifecycle sequence: start → stop → restart ---

test('enforcement loop can be restarted after being stopped', () => {
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: createDefaultIntervals(),
    logger: silentLogger,
  });

  loop.start();
  assert.equal(loop.isRunning(), true);

  loop.stop();
  assert.equal(loop.isRunning(), false);

  loop.start();
  assert.equal(loop.isRunning(), true, 'should be running again after restart');
  loop.stop();
});
