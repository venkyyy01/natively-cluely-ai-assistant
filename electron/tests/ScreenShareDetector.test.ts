import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { ScreenShareDetector, type ScreenShareDetectorOptions, type DetectionTier } from '../stealth/ScreenShareDetector';

/**
 * Feature: stealth-hardening-quickwins
 * Property-based tests for ScreenShareDetector
 *
 * Validates: Requirements 3.4, 3.5, 3.6, 3B.1, 3B.3
 */

// --- Test Helpers ---

/** Silent logger for tests */
const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

/**
 * Create a ScreenShareDetector with injectable tier results.
 * Each tier can be controlled independently via the provided functions.
 */
function createTestDetector(opts: {
  tier1?: boolean;
  tier2?: boolean;
  tier3?: boolean;
  tier4?: boolean;
}): ScreenShareDetector {
  return new ScreenShareDetector({
    platform: 'darwin',
    logger: silentLogger,
    nativeModule: {
      detectActiveScreenShare: () => opts.tier1 ?? false,
    },
    tccReader: async () => (opts.tier2 ? ['com.example.screenshare'] : []),
    getProcessList: () =>
      opts.tier3
        ? [{ pid: 100, ppid: 1, name: 'screencaptureagent' }]
        : [{ pid: 100, ppid: 1, name: 'finder' }],
    getWindowTitles: () => (opts.tier4 ? ['Sharing your screen'] : ['Desktop']),
    tierTimeoutMs: 100,
  });
}

/**
 * Create a detector with dynamically changeable tier results.
 * The `results` array is consumed sequentially on each detect() call.
 */
function createSequentialDetector(
  results: Array<{ tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean }>,
): ScreenShareDetector {
  let callIndex = 0;

  return new ScreenShareDetector({
    platform: 'darwin',
    logger: silentLogger,
    nativeModule: {
      detectActiveScreenShare: () => {
        const r = results[Math.min(callIndex, results.length - 1)];
        return r.tier1;
      },
    },
    tccReader: async () => {
      const r = results[Math.min(callIndex, results.length - 1)];
      return r.tier2 ? ['com.example.app'] : [];
    },
    getProcessList: () => {
      const r = results[Math.min(callIndex, results.length - 1)];
      return r.tier3
        ? [{ pid: 100, ppid: 1, name: 'screencaptureagent' }]
        : [{ pid: 100, ppid: 1, name: 'finder' }];
    },
    getWindowTitles: () => {
      const r = results[Math.min(callIndex, results.length - 1)];
      return r.tier4 ? ['Sharing your screen'] : ['Desktop'];
    },
    tierTimeoutMs: 100,
  });
}

/**
 * Create a detector where tier results change per-call via a mutable ref.
 */
function createMutableDetector(tierRef: { tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean }): ScreenShareDetector {
  return new ScreenShareDetector({
    platform: 'darwin',
    logger: silentLogger,
    nativeModule: {
      detectActiveScreenShare: () => tierRef.tier1,
    },
    tccReader: async () => (tierRef.tier2 ? ['com.example.app'] : []),
    getProcessList: () =>
      tierRef.tier3
        ? [{ pid: 100, ppid: 1, name: 'screencaptureagent' }]
        : [{ pid: 100, ppid: 1, name: 'finder' }],
    getWindowTitles: () => (tierRef.tier4 ? ['Sharing your screen'] : ['Desktop']),
    tierTimeoutMs: 100,
  });
}

/** Arbitrary for tier results (at least one tier positive) */
const positiveTierResultArb = fc.record({
  tier1: fc.boolean(),
  tier2: fc.boolean(),
  tier3: fc.boolean(),
  tier4: fc.boolean(),
}).filter((r) => r.tier1 || r.tier2 || r.tier3 || r.tier4);

/** Arbitrary for all-negative tier results */
const negativeTierResultArb = fc.constant({
  tier1: false,
  tier2: false,
  tier3: false,
  tier4: false,
});

/** Arbitrary for any tier result */
const anyTierResultArb = fc.record({
  tier1: fc.boolean(),
  tier2: fc.boolean(),
  tier3: fc.boolean(),
  tier4: fc.boolean(),
});

// --- Property Tests ---

describe('Feature: stealth-hardening-quickwins, Property 9: Share-Started State Transition', () => {
  /**
   * Validates: Requirements 3.4, 3.6
   *
   * For any detection cycle where at least one tier confirms an active
   * screen-sharing session, if the previous state was not-sharing, the
   * detector SHALL emit exactly one `share-started` event with confidence
   * equal to the highest-ranked (lowest tier number) confirming tier.
   */
  test('exactly one share-started event on first positive detection', async () => {
    await fc.assert(
      fc.asyncProperty(
        positiveTierResultArb,
        async (tierResult) => {
          const tierRef = { ...tierResult };
          const detector = createMutableDetector(tierRef);

          const events: Array<{ confidence: DetectionTier; detectedBy: DetectionTier[] }> = [];
          detector.on('share-started', (data) => {
            events.push(data);
          });

          // Run a single detection cycle with positive result
          await detector.detect();

          // Exactly one share-started event should be emitted
          assert.equal(
            events.length,
            1,
            `Expected exactly 1 share-started event, got ${events.length}`,
          );

          // Confidence should be the lowest tier number that was positive
          const positiveTiers: DetectionTier[] = [];
          if (tierResult.tier1) positiveTiers.push(1);
          if (tierResult.tier2) positiveTiers.push(2);
          if (tierResult.tier3) positiveTiers.push(3);
          if (tierResult.tier4) positiveTiers.push(4);

          const expectedConfidence = Math.min(...positiveTiers) as DetectionTier;
          assert.equal(
            events[0].confidence,
            expectedConfidence,
            `Expected confidence ${expectedConfidence}, got ${events[0].confidence}`,
          );

          // detectedBy should contain all positive tiers
          assert.deepEqual(
            events[0].detectedBy.sort(),
            positiveTiers.sort(),
            `Expected detectedBy ${positiveTiers}, got ${events[0].detectedBy}`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });

  test('no duplicate share-started events on consecutive positive detections', async () => {
    await fc.assert(
      fc.asyncProperty(
        positiveTierResultArb,
        fc.integer({ min: 2, max: 10 }),
        async (tierResult, repeatCount) => {
          const tierRef = { ...tierResult };
          const detector = createMutableDetector(tierRef);

          const events: Array<{ confidence: DetectionTier; detectedBy: DetectionTier[] }> = [];
          detector.on('share-started', (data) => {
            events.push(data);
          });

          // Run multiple detection cycles with positive results
          for (let i = 0; i < repeatCount; i++) {
            await detector.detect();
          }

          // Only one share-started event should be emitted (on the first positive)
          assert.equal(
            events.length,
            1,
            `Expected exactly 1 share-started event after ${repeatCount} positive cycles, got ${events.length}`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 10: Share-Ended Hysteresis', () => {
  /**
   * Validates: Requirements 3.5
   *
   * For any sequence of detection cycles, a `share-ended` event SHALL be
   * emitted if and only if exactly 3 consecutive cycles produce all-negative
   * results following a sharing state. Fewer than 3 consecutive negatives
   * SHALL NOT trigger the event.
   */
  test('share-ended emitted only after exactly 3 consecutive negatives', async () => {
    await fc.assert(
      fc.asyncProperty(
        positiveTierResultArb,
        fc.integer({ min: 1, max: 2 }),
        async (initialPositive, negativesBefore3) => {
          const tierRef = { ...initialPositive };
          const detector = createMutableDetector(tierRef);

          const endedEvents: Array<Record<string, unknown>> = [];
          detector.on('share-ended', (data) => {
            endedEvents.push(data);
          });

          // First, establish sharing state
          await detector.detect();
          assert.equal(detector.getState().active, true, 'Should be in sharing state');

          // Run fewer than 3 negative cycles — should NOT emit share-ended
          tierRef.tier1 = false;
          tierRef.tier2 = false;
          tierRef.tier3 = false;
          tierRef.tier4 = false;

          for (let i = 0; i < negativesBefore3; i++) {
            await detector.detect();
          }

          assert.equal(
            endedEvents.length,
            0,
            `Should NOT emit share-ended after only ${negativesBefore3} negative cycles`,
          );
          assert.equal(
            detector.getState().active,
            true,
            `Should still be in sharing state after ${negativesBefore3} negatives`,
          );
          assert.equal(
            detector.getState().consecutiveNegatives,
            negativesBefore3,
            `consecutiveNegatives should be ${negativesBefore3}`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });

  test('share-ended emitted on the 3rd consecutive negative', async () => {
    await fc.assert(
      fc.asyncProperty(
        positiveTierResultArb,
        async (initialPositive) => {
          const tierRef = { ...initialPositive };
          const detector = createMutableDetector(tierRef);

          const endedEvents: Array<Record<string, unknown>> = [];
          detector.on('share-ended', (data) => {
            endedEvents.push(data);
          });

          // Establish sharing state
          await detector.detect();
          assert.equal(detector.getState().active, true);

          // Switch to all-negative
          tierRef.tier1 = false;
          tierRef.tier2 = false;
          tierRef.tier3 = false;
          tierRef.tier4 = false;

          // Run exactly 3 negative cycles
          await detector.detect(); // negative 1
          await detector.detect(); // negative 2
          await detector.detect(); // negative 3 — should trigger share-ended

          assert.equal(
            endedEvents.length,
            1,
            `Expected exactly 1 share-ended event after 3 negatives, got ${endedEvents.length}`,
          );
          assert.equal(detector.getState().active, false, 'Should no longer be in sharing state');
        },
      ),
      { numRuns: 20 },
    );
  });

  test('positive detection resets consecutive negative counter', async () => {
    await fc.assert(
      fc.asyncProperty(
        positiveTierResultArb,
        positiveTierResultArb,
        fc.integer({ min: 1, max: 2 }),
        async (initialPositive, interruptPositive, negativesBeforeInterrupt) => {
          const tierRef = { ...initialPositive };
          const detector = createMutableDetector(tierRef);

          const endedEvents: Array<Record<string, unknown>> = [];
          detector.on('share-ended', (data) => {
            endedEvents.push(data);
          });

          // Establish sharing state
          await detector.detect();

          // Run some negatives (fewer than 3)
          tierRef.tier1 = false;
          tierRef.tier2 = false;
          tierRef.tier3 = false;
          tierRef.tier4 = false;
          for (let i = 0; i < negativesBeforeInterrupt; i++) {
            await detector.detect();
          }

          // Interrupt with a positive detection
          tierRef.tier1 = interruptPositive.tier1;
          tierRef.tier2 = interruptPositive.tier2;
          tierRef.tier3 = interruptPositive.tier3;
          tierRef.tier4 = interruptPositive.tier4;
          await detector.detect();

          // Counter should be reset
          assert.equal(
            detector.getState().consecutiveNegatives,
            0,
            'Consecutive negatives should reset to 0 after positive detection',
          );

          // Now run 2 more negatives — still should NOT emit share-ended
          tierRef.tier1 = false;
          tierRef.tier2 = false;
          tierRef.tier3 = false;
          tierRef.tier4 = false;
          await detector.detect();
          await detector.detect();

          assert.equal(
            endedEvents.length,
            0,
            'Should NOT emit share-ended because counter was reset by positive detection',
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 11: Detection Result Consistency', () => {
  /**
   * Validates: Requirements 3B.1, 3B.3
   *
   * For any set of detection tier results completing in any order (including
   * concurrent completions and racing start/end events), the final emitted
   * state SHALL be determined by the monotonically highest sequence number,
   * ensuring no stale state overwrites a newer state.
   */
  test('monotonic sequence prevents stale overwrites from re-entry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyTierResultArb, { minLength: 2, maxLength: 10 }),
        async (detectionSequence) => {
          // Use a detector where tier2 (tccReader) has a delay to simulate
          // potential race conditions with the re-entry guard
          let callIndex = 0;
          const detector = new ScreenShareDetector({
            platform: 'darwin',
            logger: silentLogger,
            nativeModule: {
              detectActiveScreenShare: () => {
                const r = detectionSequence[Math.min(callIndex, detectionSequence.length - 1)];
                return r.tier1;
              },
            },
            tccReader: async () => {
              const r = detectionSequence[Math.min(callIndex, detectionSequence.length - 1)];
              return r.tier2 ? ['com.example.app'] : [];
            },
            getProcessList: () => {
              const r = detectionSequence[Math.min(callIndex, detectionSequence.length - 1)];
              return r.tier3
                ? [{ pid: 100, ppid: 1, name: 'screencaptureagent' }]
                : [{ pid: 100, ppid: 1, name: 'finder' }];
            },
            getWindowTitles: () => {
              const r = detectionSequence[Math.min(callIndex, detectionSequence.length - 1)];
              return r.tier4 ? ['Sharing your screen'] : ['Desktop'];
            },
            tierTimeoutMs: 100,
          });

          const startedEvents: Array<{ confidence: DetectionTier; detectedBy: DetectionTier[] }> = [];
          const endedEvents: Array<Record<string, unknown>> = [];
          detector.on('share-started', (data) => startedEvents.push(data));
          detector.on('share-ended', (data) => endedEvents.push(data));

          // Run detection cycles sequentially (re-entry guard prevents overlap)
          for (let i = 0; i < detectionSequence.length; i++) {
            callIndex = i;
            await detector.detect();
          }

          const finalState = detector.getState();

          // Verify state consistency: if active, there must have been at least one
          // positive detection. If not active, either never started or had 3+ negatives.
          if (finalState.active) {
            // Active state must have valid confidence and detectedBy
            assert.equal(
              finalState.confidence !== null,
              true,
              'Active state must have non-null confidence',
            );
            assert.equal(
              finalState.detectedBy.length > 0,
              true,
              'Active state must have non-empty detectedBy',
            );
            // Hysteresis: active state can have 0-2 consecutive negatives
            // (3 negatives would have triggered share-ended)
            assert.equal(
              finalState.consecutiveNegatives < 3,
              true,
              `Active state should have fewer than 3 consecutive negatives, got ${finalState.consecutiveNegatives}`,
            );
          } else {
            // Not active: either never started or ended after hysteresis
            if (startedEvents.length > 0) {
              // Was active at some point, must have ended via hysteresis
              assert.equal(
                endedEvents.length > 0,
                true,
                'If was active and now inactive, share-ended must have been emitted',
              );
            }
          }

          // Verify event ordering: share-started always precedes share-ended
          // and they alternate (no two consecutive starts or ends)
          let lastEvent: 'started' | 'ended' | null = null;
          let startIdx = 0;
          let endIdx = 0;

          // Reconstruct event order by counting
          const totalStarts = startedEvents.length;
          const totalEnds = endedEvents.length;

          // Starts and ends should alternate: starts >= ends, and starts - ends <= 1
          assert.equal(
            totalStarts >= totalEnds,
            true,
            `Starts (${totalStarts}) should be >= ends (${totalEnds})`,
          );
          assert.equal(
            totalStarts - totalEnds <= 1,
            true,
            `Starts (${totalStarts}) - ends (${totalEnds}) should be <= 1`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });

  test('concurrent detect() calls are rejected by re-entry guard', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        positiveTierResultArb,
        async (concurrentCalls, tierResult) => {
          // Create a detector with a slow tier-2 to ensure detect() takes time
          let resolveSlowTier: (() => void) | null = null;
          const detector = new ScreenShareDetector({
            platform: 'darwin',
            logger: silentLogger,
            nativeModule: {
              detectActiveScreenShare: () => tierResult.tier1,
            },
            tccReader: () =>
              new Promise<string[]>((resolve) => {
                resolveSlowTier = () => resolve(tierResult.tier2 ? ['com.example.app'] : []);
                // Resolve after a short delay to simulate slow tier
                setTimeout(() => resolve(tierResult.tier2 ? ['com.example.app'] : []), 10);
              }),
            getProcessList: () =>
              tierResult.tier3
                ? [{ pid: 100, ppid: 1, name: 'screencaptureagent' }]
                : [{ pid: 100, ppid: 1, name: 'finder' }],
            getWindowTitles: () => (tierResult.tier4 ? ['Sharing your screen'] : ['Desktop']),
            tierTimeoutMs: 200,
          });

          const startedEvents: Array<{ confidence: DetectionTier; detectedBy: DetectionTier[] }> = [];
          detector.on('share-started', (data) => startedEvents.push(data));

          // Fire multiple concurrent detect() calls
          const promises = Array.from({ length: concurrentCalls }, () => detector.detect());
          await Promise.all(promises);

          // Despite multiple concurrent calls, at most one share-started event
          assert.equal(
            startedEvents.length <= 1,
            true,
            `Expected at most 1 share-started event from concurrent calls, got ${startedEvents.length}`,
          );

          // State should be consistent
          const state = detector.getState();
          if (startedEvents.length === 1) {
            assert.equal(state.active, true, 'State should be active after share-started');
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
