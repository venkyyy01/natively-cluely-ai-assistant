/**
 * Unit tests for ScreenShareDetector.
 *
 * Validates: Requirements 3.3, 3B.2, 3B.4
 *
 * Tests tier timeout handling, cross-platform fallback behavior,
 * and re-entry guard preventing overlapping detection cycles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ScreenShareDetector, type ScreenShareDetectorOptions } from '../stealth/ScreenShareDetector';

const silentLogger = { log() {}, warn() {}, error() {} };

function createDetector(overrides: ScreenShareDetectorOptions = {}): ScreenShareDetector {
  return new ScreenShareDetector({
    platform: 'darwin',
    logger: silentLogger,
    ...overrides,
  });
}

// --- Tier Timeout Handling (Req 3B.4) ---

test('tier that exceeds timeout resolves as false and detection proceeds', async () => {
  const detector = createDetector({
    tierTimeoutMs: 50,
    // Tier 2 (TCC reader) will hang beyond timeout
    tccReader: () => new Promise(() => { /* never resolves */ }),
    // Tier 3 detects a share
    getProcessList: () => [{ pid: 1, ppid: 0, name: 'screencaptureagent' }],
  });

  const state = await detector.detect();

  // Detection should succeed via tier 3 despite tier 2 timing out
  assert.equal(state.active, true);
  assert.ok(state.detectedBy.includes(3), 'tier 3 should be in detectedBy');
  assert.ok(!state.detectedBy.includes(2), 'timed-out tier 2 should not be in detectedBy');
});

test('all tiers timing out results in no detection (state remains inactive)', async () => {
  const detector = createDetector({
    tierTimeoutMs: 50,
    nativeModule: {
      detectActiveScreenShare: () => {
        // Simulate a synchronous tier that works fine
        return false;
      },
    },
    tccReader: () => new Promise(() => { /* never resolves */ }),
    getProcessList: () => [],
    getWindowTitles: () => [],
  });

  const state = await detector.detect();

  assert.equal(state.active, false);
  assert.equal(state.detectedBy.length, 0);
});

test('timeout does not block other tiers from completing', async () => {
  const detector = createDetector({
    tierTimeoutMs: 50,
    // Tier 1 hangs
    nativeModule: {
      detectActiveScreenShare: (): boolean => {
        // Simulate a long-running native call by blocking (but since it's sync, it won't timeout)
        return false;
      },
    },
    // Tier 2 hangs
    tccReader: () => new Promise(() => { /* never resolves */ }),
    // Tier 3 detects
    getProcessList: () => [{ pid: 100, ppid: 1, name: 'zoom.us cpthost' }],
    // Tier 4 also detects
    getWindowTitles: () => ['Sharing your screen'],
  });

  const state = await detector.detect();

  assert.equal(state.active, true);
  assert.ok(state.detectedBy.includes(3));
  assert.ok(state.detectedBy.includes(4));
});

test('tier that throws an error resolves as false', async () => {
  const detector = createDetector({
    tierTimeoutMs: 2000,
    tccReader: async () => { throw new Error('TCC access denied'); },
    getProcessList: () => { throw new Error('process enumeration failed'); },
    getWindowTitles: () => ['Sharing your screen'],
  });

  const state = await detector.detect();

  // Only tier 4 should succeed
  assert.equal(state.active, true);
  assert.deepEqual(state.detectedBy, [4]);
});

// --- Cross-Platform Fallback Behavior (Req 3.3) ---

test('non-macOS platform only runs tier 3 (process-name matching)', async () => {
  let tier3Called = false;
  let warnMessages: string[] = [];

  const detector = createDetector({
    platform: 'win32',
    logger: {
      log() {},
      warn(...args: unknown[]) { warnMessages.push(String(args[0])); },
      error() {},
    },
    nativeModule: {
      detectActiveScreenShare: () => true, // Should NOT be called
    },
    tccReader: async () => ['com.zoom.us'], // Should NOT be called
    getProcessList: () => {
      tier3Called = true;
      return [{ pid: 1, ppid: 0, name: 'screencaptureagent' }];
    },
    getWindowTitles: () => ['Sharing your screen'], // Should NOT be called on non-macOS
  });

  const state = await detector.detect();

  assert.equal(tier3Called, true, 'tier 3 should be called on non-macOS');
  assert.equal(state.active, true);
  // Only tier 3 should be in detectedBy (tiers 1, 2, 4 are macOS-only)
  assert.deepEqual(state.detectedBy, [3]);
});

test('non-macOS platform emits invisibility unverified warning', async () => {
  let warnMessages: string[] = [];

  const detector = createDetector({
    platform: 'linux',
    logger: {
      log() {},
      warn(...args: unknown[]) { warnMessages.push(String(args[0])); },
      error() {},
    },
    getProcessList: () => [],
  });

  await detector.detect();

  const hasWarning = warnMessages.some(msg => msg.includes('Non-macOS platform'));
  assert.ok(hasWarning, 'should emit invisibility unverified warning for non-macOS');
});

test('Windows platform with no matching processes reports inactive', async () => {
  const detector = createDetector({
    platform: 'win32',
    getProcessList: () => [
      { pid: 1, ppid: 0, name: 'explorer.exe' },
      { pid: 2, ppid: 1, name: 'chrome.exe' },
    ],
  });

  const state = await detector.detect();

  assert.equal(state.active, false);
  assert.equal(state.detectedBy.length, 0);
});

test('macOS platform runs all 4 tiers', async () => {
  let tiersExecuted: number[] = [];

  const detector = createDetector({
    platform: 'darwin',
    nativeModule: {
      detectActiveScreenShare: () => {
        tiersExecuted.push(1);
        return false;
      },
    },
    tccReader: async () => {
      tiersExecuted.push(2);
      return [];
    },
    getProcessList: () => {
      tiersExecuted.push(3);
      return [];
    },
    getWindowTitles: () => {
      tiersExecuted.push(4);
      return [];
    },
  });

  await detector.detect();

  assert.ok(tiersExecuted.includes(1), 'tier 1 should run on macOS');
  assert.ok(tiersExecuted.includes(2), 'tier 2 should run on macOS');
  assert.ok(tiersExecuted.includes(3), 'tier 3 should run on macOS');
  assert.ok(tiersExecuted.includes(4), 'tier 4 should run on macOS');
});

// --- Re-entry Guard Prevents Overlapping Cycles (Req 3B.2) ---

test('concurrent detect() calls are rejected by re-entry guard', async () => {
  let resolveDetection: (() => void) | null = null;
  let callCount = 0;

  const detector = createDetector({
    getProcessList: () => {
      callCount++;
      return [];
    },
    tccReader: () => new Promise<string[]>((resolve) => {
      resolveDetection = () => resolve([]);
    }),
  });

  // Start first detection (will block on tccReader)
  const firstDetection = detector.detect();

  // Attempt second detection while first is in progress
  const secondResult = await detector.detect();

  // Second call should return immediately with current state (no new detection)
  assert.equal(secondResult.active, false);

  // Resolve the first detection
  resolveDetection!();
  await firstDetection;

  // getProcessList should only have been called once (from the first detection)
  assert.equal(callCount, 1, 're-entry guard should prevent second detection cycle');
});

test('re-entry guard is released after detection completes', async () => {
  let callCount = 0;

  const detector = createDetector({
    getProcessList: () => {
      callCount++;
      return [{ pid: 1, ppid: 0, name: 'screencaptureagent' }];
    },
  });

  // First detection
  await detector.detect();
  assert.equal(callCount, 1);

  // Second detection should proceed normally after first completes
  await detector.detect();
  assert.equal(callCount, 2, 'guard should be released after detection completes');
});

test('re-entry guard is released even if detection throws', async () => {
  let callCount = 0;

  const detector = createDetector({
    tccReader: async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('simulated failure');
      }
      return ['com.zoom.us'];
    },
    getProcessList: () => [],
  });

  // First detection — tccReader throws but detection should still complete
  await detector.detect();

  // Second detection should proceed (guard released despite error)
  const state = await detector.detect();
  assert.equal(callCount, 2, 'guard should be released after error');
  assert.equal(state.active, true, 'second detection should work normally');
});

test('re-entry guard returns current state snapshot', async () => {
  let resolveDetection: (() => void) | null = null;

  const detector = createDetector({
    tccReader: () => new Promise<string[]>((resolve) => {
      resolveDetection = () => resolve(['com.zoom.us']);
    }),
    getProcessList: () => [{ pid: 1, ppid: 0, name: 'screencaptureagent' }],
  });

  // Run a detection to set state to active (using tier 3 which is sync)
  // First, set up a quick detection
  const quickDetector = createDetector({
    getProcessList: () => [{ pid: 1, ppid: 0, name: 'screencaptureagent' }],
  });
  await quickDetector.detect();
  const activeState = quickDetector.getState();
  assert.equal(activeState.active, true);

  // Now test re-entry on the original detector — it should return the current (inactive) state
  const firstDetection = detector.detect();
  const guardedResult = await detector.detect();

  // The guarded result should reflect the current state (still inactive since first hasn't completed)
  assert.equal(guardedResult.active, false);

  // Clean up
  resolveDetection!();
  await firstDetection;
});

// --- Additional edge cases ---

test('missing providers return false for their tier', async () => {
  // No providers configured at all
  const detector = createDetector({
    platform: 'darwin',
    // All providers undefined
  });

  const state = await detector.detect();

  assert.equal(state.active, false);
  assert.equal(state.detectedBy.length, 0);
});

test('confidence reports highest-ranked (lowest tier number) detecting tier', async () => {
  const detector = createDetector({
    nativeModule: { detectActiveScreenShare: () => false },
    tccReader: async () => ['com.zoom.us'], // tier 2 detects
    getProcessList: () => [{ pid: 1, ppid: 0, name: 'screencaptureagent' }], // tier 3 detects
    getWindowTitles: () => ['Sharing your screen'], // tier 4 detects
  });

  const state = await detector.detect();

  assert.equal(state.active, true);
  assert.equal(state.confidence, 2, 'confidence should be tier 2 (highest-ranked detecting tier)');
  assert.deepEqual(state.detectedBy, [2, 3, 4]);
});
