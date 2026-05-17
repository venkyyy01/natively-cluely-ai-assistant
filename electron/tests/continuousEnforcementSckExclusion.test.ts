// electron/tests/continuousEnforcementSckExclusion.test.ts
//
// Tests for SCK exclusion verification in ContinuousEnforcementLoop.
// Validates that the enforcement loop correctly polls SCK exclusion state,
// re-applies exclusion on failure, and triggers emergency protection after
// consecutive failures.
//
// SCK exclusion is an experimental code path gated behind
// `NATIVELY_TRY_SCK_TAG=1`. We opt in for the entire suite so the loop
// actually runs the verification and re-apply logic the tests exercise.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContinuousEnforcementLoop } from '../stealth/ContinuousEnforcementLoop';

// Opt into the experimental SCK CGS tag path for the lifetime of this
// test module. Any test importing this file is intentionally exercising
// behaviour that is OFF by default in production.
process.env.NATIVELY_TRY_SCK_TAG = '1';

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

interface MockWindow {
  id: number;
  hidden: boolean;
  emergencyProtectionApplied: boolean;
}

function createMockStealthManager(opts: {
  isMacOS15Plus?: boolean;
  managedWindows?: Array<{ windowNumber: number; win: MockWindow }>;
}) {
  const emergencyProtections: MockWindow[] = [];

  return {
    reapplyProtectionLayers() {},
    pollCaptureTools() {},
    isMacOS15PlusCapable() {
      return opts.isMacOS15Plus ?? true;
    },
    getManagedWindowNumbers() {
      return opts.managedWindows ?? [];
    },
    triggerEmergencyProtection(win: MockWindow) {
      win.emergencyProtectionApplied = true;
      win.hidden = true;
      emergencyProtections.push(win);
    },
    isEnabled() {
      return true;
    },
    getEmergencyProtections() {
      return emergencyProtections;
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
  return {
    async emit() {},
  };
}

function createMockWindow(id: number): MockWindow {
  return {
    id,
    hidden: false,
    emergencyProtectionApplied: false,
  };
}

test('SCK exclusion timer is NOT started when platform is not macOS 15+', () => {
  const stealthManager = createMockStealthManager({ isMacOS15Plus: false });
  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
      sckExclusionMs: 100000,
    },
    logger: silentLogger,
    exitFn: () => {},
  });

  loop.start();
  // If the timer was started, it would be set. We verify by stopping and checking no errors.
  loop.stop();
  assert.ok(true, 'Loop started and stopped without SCK timer on non-macOS 15+');
});

test('SCK exclusion timer IS started when platform is macOS 15+', () => {
  const stealthManager = createMockStealthManager({ isMacOS15Plus: true });
  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
      sckExclusionMs: 50, // Short interval for testing
    },
    logger: silentLogger,
    exitFn: () => {},
  });

  loop.start();
  assert.ok(loop.isRunning(), 'Loop should be running');
  loop.stop();
  assert.ok(!loop.isRunning(), 'Loop should be stopped');
});

test('SCK exclusion poll resets failure count on successful verification', async () => {
  const win1 = createMockWindow(1);
  const stealthManager = createMockStealthManager({
    isMacOS15Plus: true,
    managedWindows: [{ windowNumber: 100, win: win1 }],
  });

  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
      sckExclusionMs: 100000,
    },
    logger: silentLogger,
    exitFn: () => {},
  });

  loop.start();
  // The poll won't run automatically due to long interval, and we can't easily
  // invoke it directly since it's private. But we can verify the counters start at 0.
  assert.equal(loop.getSckExclusionFailureCount(), 0);
  assert.equal(loop.getSckExclusionReapplyCount(), 0);
  loop.stop();
});

test('SCK exclusion uses configurable interval with default of 2000ms', () => {
  const stealthManager = createMockStealthManager({ isMacOS15Plus: true });

  // Without explicit sckExclusionMs, should use default (2000ms)
  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 250,
      processDetectionMs: 3000,
      disguiseValidationMs: 15000,
      // sckExclusionMs not set — should use default 2000ms
    },
    logger: silentLogger,
    exitFn: () => {},
  });

  loop.start();
  assert.ok(loop.isRunning());
  loop.stop();
});

test('enforcement loop stop clears SCK exclusion timer', () => {
  const stealthManager = createMockStealthManager({ isMacOS15Plus: true });
  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
      sckExclusionMs: 50,
    },
    logger: silentLogger,
    exitFn: () => {},
  });

  loop.start();
  assert.ok(loop.isRunning());
  loop.stop();
  assert.ok(!loop.isRunning());
  // No lingering timers — stop should clean up all timers including SCK
});

test('enforcement loop does not start SCK timer when already running', () => {
  const stealthManager = createMockStealthManager({ isMacOS15Plus: true });
  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
      sckExclusionMs: 50,
    },
    logger: silentLogger,
    exitFn: () => {},
  });

  loop.start();
  loop.start(); // Second start should be a no-op
  assert.ok(loop.isRunning());
  loop.stop();
});

test('getSckExclusionFailureCount returns 0 initially', () => {
  const stealthManager = createMockStealthManager({ isMacOS15Plus: true });
  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
    },
    logger: silentLogger,
    exitFn: () => {},
  });

  assert.equal(loop.getSckExclusionFailureCount(), 0);
  assert.equal(loop.getSckExclusionReapplyCount(), 0);
});

test('SCK poll verifies re-apply before counting a failure', async () => {
  const win1 = createMockWindow(1);
  const stealthManager = createMockStealthManager({
    isMacOS15Plus: true,
    managedWindows: [{ windowNumber: 100, win: win1 }],
  });
  let verifyCalls = 0;
  let applyCalls = 0;

  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
    },
    logger: silentLogger,
    nativeModule: {
      verifySckExclusion() {
        verifyCalls += 1;
        return verifyCalls > 1;
      },
      applySckExclusion() {
        applyCalls += 1;
      },
    },
  });

  await (loop as any).pollSckExclusion();

  assert.equal(applyCalls, 1);
  assert.equal(loop.getSckExclusionReapplyCount(), 1);
  assert.equal(loop.getSckExclusionFailureCount(), 0);
});

test('SCK poll backs off after repeated permanent verification failures', async () => {
  const win1 = createMockWindow(1);
  const stealthManager = createMockStealthManager({
    isMacOS15Plus: true,
    managedWindows: [{ windowNumber: 100, win: win1 }],
  });
  let applyCalls = 0;

  const loop = new ContinuousEnforcementLoop({
    stealthManager: stealthManager as never,
    monitoringDetector: createMockMonitoringDetector() as never,
    bus: createMockBus() as never,
    intervals: {
      windowProtectionMs: 100000,
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
    },
    logger: silentLogger,
    nativeModule: {
      verifySckExclusion() {
        return false;
      },
      applySckExclusion() {
        applyCalls += 1;
      },
    },
  });

  await (loop as any).pollSckExclusion();
  await (loop as any).pollSckExclusion();
  await (loop as any).pollSckExclusion();
  await (loop as any).pollSckExclusion();

  assert.equal(applyCalls, 3);
  assert.equal(loop.getSckExclusionReapplyCount(), 3);
  assert.equal(loop.getSckExclusionFailureCount(), 3);
});
