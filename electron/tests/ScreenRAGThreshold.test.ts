/**
 * Property-based tests for ScreenRAG threshold activation and event-driven sampling.
 *
 * Feature: stealth-hardening-quickwins
 * Validates: Requirements 8.1, 8.4, 8B.1, 8B.2, 8B.3
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

// ─── Mock Setup ───────────────────────────────────────────────────────────────
// We mock electron app, screenshot-desktop, and tesseract.js to isolate
// the threshold/activation/suppression logic for property testing.

const mockBeforeQuitHandlers: Array<() => void> = [];
const mockApp = {
  getPath: (name: string) => os.tmpdir(),
  on: (event: string, handler: () => void) => {
    if (event === 'before-quit') mockBeforeQuitHandlers.push(handler);
  },
  removeListener: (event: string, handler: () => void) => {
    if (event === 'before-quit') {
      const idx = mockBeforeQuitHandlers.indexOf(handler);
      if (idx >= 0) mockBeforeQuitHandlers.splice(idx, 1);
    }
  },
};

// ─── Test Harness ─────────────────────────────────────────────────────────────
// Replicates the threshold activation, suppression, and idempotent tick logic
// from ScreenRAGManager for property-based testing without requiring electron.

/**
 * Minimal harness replicating ScreenRAGManager's threshold activation,
 * suppression, and idempotent tick handling logic.
 */
class ScreenRAGThresholdHarness {
  private screenshotCount = 0;
  private activated = false;
  private sampling = false;
  private disposed = false;
  private readonly activationThreshold: number;

  // Suppression conditions
  private windowHidden = false;
  private screenLocked = false;
  private screenShareActive = false;

  // Tracking for property verification
  public activationEvents: number[] = []; // timestamps of activation
  public sampleAttempts: number[] = []; // timestamps of sample starts
  public ocrStartCount = 0;

  constructor(threshold = 3) {
    this.activationThreshold = threshold;
  }

  /**
   * Increment screenshot counter. Auto-activates at threshold.
   * Mirrors ScreenRAGManager.recordScreenshot().
   */
  recordScreenshot(): void {
    if (this.disposed) return;

    this.screenshotCount++;

    // Auto-activate exactly once upon reaching threshold
    if (!this.activated && this.screenshotCount >= this.activationThreshold) {
      this.activated = true;
      this.activationEvents.push(Date.now());
    }
  }

  /**
   * Called on idle ticks. Performs sampling if conditions allow.
   * Mirrors ScreenRAGManager.onIdleTick().
   */
  async onIdleTick(): Promise<void> {
    // Guard: not activated, disposed, or already sampling
    if (!this.activated || this.disposed || this.sampling) {
      return;
    }

    // Check suppression conditions
    if (!this.canSample()) {
      return;
    }

    // Set sampling flag to prevent re-entry
    this.sampling = true;
    this.ocrStartCount++;
    this.sampleAttempts.push(Date.now());

    try {
      // Simulate OCR work
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Simulate an idle tick that starts OCR but does NOT complete it.
   * Used for testing idempotent tick handling (Property 23).
   */
  startSamplingWithoutComplete(): boolean {
    if (!this.activated || this.disposed || this.sampling) {
      return false;
    }
    if (!this.canSample()) {
      return false;
    }
    this.sampling = true;
    this.ocrStartCount++;
    this.sampleAttempts.push(Date.now());
    return true;
  }

  /**
   * Complete a previously started sampling operation.
   */
  completeSampling(): void {
    this.sampling = false;
  }

  /**
   * Reset counter and deactivate (meeting/session end).
   * Mirrors ScreenRAGManager.resetSession().
   */
  resetSession(): void {
    this.screenshotCount = 0;
    this.activated = false;
    this.sampling = false;
  }

  /**
   * Check if conditions allow sampling.
   * Mirrors ScreenRAGManager.canSample().
   */
  canSample(): boolean {
    if (this.disposed) return false;
    if (!this.activated) return false;
    if (this.windowHidden) return false;
    if (this.screenLocked) return false;
    if (this.screenShareActive) return false;
    return true;
  }

  setWindowHidden(hidden: boolean): void {
    this.windowHidden = hidden;
  }

  setScreenLocked(locked: boolean): void {
    this.screenLocked = locked;
  }

  setScreenShareActive(active: boolean): void {
    this.screenShareActive = active;
  }

  isActivated(): boolean {
    return this.activated;
  }

  isSampling(): boolean {
    return this.sampling;
  }

  getScreenshotCount(): number {
    return this.screenshotCount;
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ─── Event types for interleaving tests ───────────────────────────────────────

type ThresholdEvent =
  | { type: 'screenshot' }
  | { type: 'reset' }
  | { type: 'tick' }
  | { type: 'setWindowHidden'; value: boolean }
  | { type: 'setScreenLocked'; value: boolean }
  | { type: 'setScreenShareActive'; value: boolean };

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const thresholdEventArb: fc.Arbitrary<ThresholdEvent> = fc.oneof(
  fc.constant({ type: 'screenshot' } as ThresholdEvent),
  fc.constant({ type: 'reset' } as ThresholdEvent),
  fc.constant({ type: 'tick' } as ThresholdEvent),
  fc.boolean().map((v) => ({ type: 'setWindowHidden', value: v } as ThresholdEvent)),
  fc.boolean().map((v) => ({ type: 'setScreenLocked', value: v } as ThresholdEvent)),
  fc.boolean().map((v) => ({ type: 'setScreenShareActive', value: v } as ThresholdEvent))
);

// ─── Property Tests ───────────────────────────────────────────────────────────

const PBT_CONFIG = { numRuns: 20 };

describe('Feature: stealth-hardening-quickwins, Property 21: Threshold Activation Exactly Once', () => {
  /**
   * Validates: Requirements 8.1, 8B.1
   *
   * For any number of screenshot events N >= 3 arriving in any timing pattern
   * (including rapid bursts), the ScreenRAGManager SHALL activate passive sampling
   * exactly once upon the counter reaching 3, and SHALL NOT activate again until
   * after a session reset.
   */
  it('activates exactly once at count 3, not again until reset', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 50 }),
        async (screenshotCount) => {
          const harness = new ScreenRAGThresholdHarness(3);

          // Fire N screenshots in rapid succession
          for (let i = 0; i < screenshotCount; i++) {
            harness.recordScreenshot();
          }

          // Should have activated exactly once
          assert.strictEqual(
            harness.activationEvents.length,
            1,
            `Expected exactly 1 activation event after ${screenshotCount} screenshots, got ${harness.activationEvents.length}`
          );
          assert.strictEqual(harness.isActivated(), true);
          assert.strictEqual(harness.getScreenshotCount(), screenshotCount);
        }
      ),
      PBT_CONFIG
    );
  });

  it('does not activate before reaching threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 }),
        async (screenshotCount) => {
          const harness = new ScreenRAGThresholdHarness(3);

          for (let i = 0; i < screenshotCount; i++) {
            harness.recordScreenshot();
          }

          // Should NOT have activated
          assert.strictEqual(harness.activationEvents.length, 0);
          assert.strictEqual(harness.isActivated(), false);
        }
      ),
      PBT_CONFIG
    );
  });

  it('re-activates exactly once after reset and reaching threshold again', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 20 }),
        fc.integer({ min: 3, max: 20 }),
        async (firstBurst, secondBurst) => {
          const harness = new ScreenRAGThresholdHarness(3);

          // First burst — should activate once
          for (let i = 0; i < firstBurst; i++) {
            harness.recordScreenshot();
          }
          assert.strictEqual(harness.activationEvents.length, 1);
          assert.strictEqual(harness.isActivated(), true);

          // Reset session
          harness.resetSession();
          assert.strictEqual(harness.isActivated(), false);
          assert.strictEqual(harness.getScreenshotCount(), 0);

          // Second burst — should activate again (exactly once more)
          for (let i = 0; i < secondBurst; i++) {
            harness.recordScreenshot();
          }
          assert.strictEqual(harness.activationEvents.length, 2);
          assert.strictEqual(harness.isActivated(), true);
        }
      ),
      PBT_CONFIG
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 22: Sampling Skip on Suppression', () => {
  /**
   * Validates: Requirements 8.4
   *
   * For any state where windowHidden OR screenLocked OR screenShareActive is true,
   * an onIdleTick() call SHALL NOT perform a screen capture or OCR operation.
   */
  it('no capture when any suppression condition is true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          windowHidden: fc.boolean(),
          screenLocked: fc.boolean(),
          screenShareActive: fc.boolean(),
        }),
        async (conditions) => {
          // At least one suppression condition must be true for this property
          const anySuppressed =
            conditions.windowHidden || conditions.screenLocked || conditions.screenShareActive;
          // Skip cases where no suppression is active (not relevant to this property)
          fc.pre(anySuppressed);

          const harness = new ScreenRAGThresholdHarness(3);

          // Activate the manager first
          harness.recordScreenshot();
          harness.recordScreenshot();
          harness.recordScreenshot();
          assert.strictEqual(harness.isActivated(), true);

          // Set suppression conditions
          harness.setWindowHidden(conditions.windowHidden);
          harness.setScreenLocked(conditions.screenLocked);
          harness.setScreenShareActive(conditions.screenShareActive);

          // Attempt idle tick — should NOT sample
          await harness.onIdleTick();

          assert.strictEqual(
            harness.ocrStartCount,
            0,
            `Expected 0 OCR starts when suppressed (windowHidden=${conditions.windowHidden}, screenLocked=${conditions.screenLocked}, screenShareActive=${conditions.screenShareActive})`
          );
          assert.strictEqual(harness.sampleAttempts.length, 0);
        }
      ),
      PBT_CONFIG
    );
  });

  it('samples normally when no suppression condition is active', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (tickCount) => {
          const harness = new ScreenRAGThresholdHarness(3);

          // Activate
          harness.recordScreenshot();
          harness.recordScreenshot();
          harness.recordScreenshot();

          // No suppression
          harness.setWindowHidden(false);
          harness.setScreenLocked(false);
          harness.setScreenShareActive(false);

          // Fire ticks sequentially (each must complete before next)
          for (let i = 0; i < tickCount; i++) {
            await harness.onIdleTick();
          }

          // Should have sampled on each tick
          assert.strictEqual(harness.ocrStartCount, tickCount);
        }
      ),
      PBT_CONFIG
    );
  });

  it('suppression mid-sequence stops further sampling', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom('windowHidden', 'screenLocked', 'screenShareActive'),
        async (ticksBefore, ticksAfter, suppressionType) => {
          const harness = new ScreenRAGThresholdHarness(3);

          // Activate
          harness.recordScreenshot();
          harness.recordScreenshot();
          harness.recordScreenshot();

          // Ticks before suppression
          for (let i = 0; i < ticksBefore; i++) {
            await harness.onIdleTick();
          }
          const countBefore = harness.ocrStartCount;
          assert.strictEqual(countBefore, ticksBefore);

          // Apply suppression
          if (suppressionType === 'windowHidden') harness.setWindowHidden(true);
          else if (suppressionType === 'screenLocked') harness.setScreenLocked(true);
          else harness.setScreenShareActive(true);

          // Ticks after suppression — should not sample
          for (let i = 0; i < ticksAfter; i++) {
            await harness.onIdleTick();
          }

          assert.strictEqual(
            harness.ocrStartCount,
            countBefore,
            `OCR count should not increase after suppression (${suppressionType})`
          );
        }
      ),
      PBT_CONFIG
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 23: Idempotent Tick Handling', () => {
  /**
   * Validates: Requirements 8B.3
   *
   * For any tick where an OCR operation is already in progress (sampling flag is true),
   * a subsequent onIdleTick() call SHALL be a no-op — no second OCR operation SHALL
   * be started.
   */
  it('no second OCR while one is in progress', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (concurrentTicks) => {
          const harness = new ScreenRAGThresholdHarness(3);

          // Activate
          harness.recordScreenshot();
          harness.recordScreenshot();
          harness.recordScreenshot();

          // Start a sampling operation without completing it
          const started = harness.startSamplingWithoutComplete();
          assert.strictEqual(started, true);
          assert.strictEqual(harness.isSampling(), true);

          const ocrCountAfterFirst = harness.ocrStartCount;

          // Fire multiple concurrent ticks while sampling is in progress
          for (let i = 0; i < concurrentTicks; i++) {
            await harness.onIdleTick();
          }

          // No additional OCR should have started
          assert.strictEqual(
            harness.ocrStartCount,
            ocrCountAfterFirst,
            `Expected no additional OCR starts while sampling in progress, but got ${harness.ocrStartCount - ocrCountAfterFirst} extra`
          );

          // Complete the sampling
          harness.completeSampling();
          assert.strictEqual(harness.isSampling(), false);

          // Now a new tick should work
          await harness.onIdleTick();
          assert.strictEqual(harness.ocrStartCount, ocrCountAfterFirst + 1);
        }
      ),
      PBT_CONFIG
    );
  });

  it('concurrent onIdleTick calls via Promise.all produce exactly one OCR start', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        async (concurrentCount) => {
          const harness = new ScreenRAGThresholdHarness(3);

          // Activate
          harness.recordScreenshot();
          harness.recordScreenshot();
          harness.recordScreenshot();

          // Fire multiple ticks concurrently
          const ticks = Array.from({ length: concurrentCount }, () => harness.onIdleTick());
          await Promise.all(ticks);

          // Only one OCR should have started (the first tick sets sampling=true,
          // subsequent ticks see sampling=true and bail out)
          assert.strictEqual(
            harness.ocrStartCount,
            1,
            `Expected exactly 1 OCR start from ${concurrentCount} concurrent ticks, got ${harness.ocrStartCount}`
          );
        }
      ),
      PBT_CONFIG
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 24: Meeting-End Race Safety', () => {
  /**
   * Validates: Requirements 8B.2
   *
   * For any interleaving of meeting-end (reset) events and screenshot events,
   * the screenshot counter SHALL be in a valid state: either 0 (if reset was the
   * last operation) or a positive integer ≤ threshold (if screenshot was the last
   * operation). The counter SHALL never be negative or exceed the threshold without
   * triggering activation.
   */
  it('counter always valid after interleaved screenshot and reset events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constant('screenshot' as const),
            fc.constant('reset' as const)
          ),
          { minLength: 1, maxLength: 50 }
        ),
        async (events) => {
          const threshold = 3;
          const harness = new ScreenRAGThresholdHarness(threshold);

          for (const event of events) {
            if (event === 'screenshot') {
              harness.recordScreenshot();
            } else {
              harness.resetSession();
            }

            // Invariant: counter is never negative
            const count = harness.getScreenshotCount();
            assert.ok(count >= 0, `Counter should never be negative, got ${count}`);

            // Invariant: if counter >= threshold, must be activated
            if (count >= threshold) {
              assert.strictEqual(
                harness.isActivated(),
                true,
                `Should be activated when count (${count}) >= threshold (${threshold})`
              );
            }

            // Invariant: if not activated, counter < threshold
            if (!harness.isActivated()) {
              assert.ok(
                count < threshold,
                `If not activated, count (${count}) should be < threshold (${threshold})`
              );
            }
          }
        }
      ),
      PBT_CONFIG
    );
  });

  it('reset always produces count=0 and deactivated state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        async (screenshotsBefore) => {
          const harness = new ScreenRAGThresholdHarness(3);

          // Fire some screenshots
          for (let i = 0; i < screenshotsBefore; i++) {
            harness.recordScreenshot();
          }

          // Reset
          harness.resetSession();

          // After reset: counter is 0, not activated
          assert.strictEqual(harness.getScreenshotCount(), 0);
          assert.strictEqual(harness.isActivated(), false);
          assert.strictEqual(harness.isSampling(), false);
        }
      ),
      PBT_CONFIG
    );
  });

  it('complex interleaving of all event types maintains valid state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(thresholdEventArb, { minLength: 5, maxLength: 30 }),
        async (events) => {
          const threshold = 3;
          const harness = new ScreenRAGThresholdHarness(threshold);

          for (const event of events) {
            switch (event.type) {
              case 'screenshot':
                harness.recordScreenshot();
                break;
              case 'reset':
                harness.resetSession();
                break;
              case 'tick':
                await harness.onIdleTick();
                break;
              case 'setWindowHidden':
                harness.setWindowHidden(event.value);
                break;
              case 'setScreenLocked':
                harness.setScreenLocked(event.value);
                break;
              case 'setScreenShareActive':
                harness.setScreenShareActive(event.value);
                break;
            }

            // Invariants that must always hold:
            const count = harness.getScreenshotCount();

            // 1. Counter is never negative
            assert.ok(count >= 0, `Counter should never be negative, got ${count}`);

            // 2. If activated, counter >= threshold (unless reset just happened)
            // Note: after reset, activated=false, so this only applies when activated=true
            if (harness.isActivated()) {
              assert.ok(
                count >= threshold,
                `If activated, count (${count}) should be >= threshold (${threshold})`
              );
            }

            // 3. If not activated and count >= threshold, something is wrong
            if (!harness.isActivated() && count >= threshold) {
              // This should never happen — activation is triggered at threshold
              assert.fail(
                `Invalid state: not activated but count (${count}) >= threshold (${threshold})`
              );
            }
          }
        }
      ),
      PBT_CONFIG
    );
  });
});
