import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { ContinuousEnforcementLoop, type EnforcementLoopOptions } from '../stealth/ContinuousEnforcementLoop';

/**
 * Feature: stealth-hardening-quickwins
 * Property-based tests for ContinuousEnforcementLoop lifecycle
 *
 * Validates: Requirements 2B.1, 2B.3
 */

// --- Test Helpers ---

/** Silent logger for tests */
const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

/** Create a mock StealthManager */
function createMockStealthManager(): any {
  return {
    reapplyProtectionLayers() {},
    getManagedWindowNumbers(): Array<{ windowNumber: number; win: any }> {
      return [];
    },
    requestWindowHide(_win: any, _opts: any) {},
    isMacOS15PlusCapable() {
      return false;
    },
    triggerEmergencyProtection(_win: any) {},
    pollCaptureTools: undefined as (() => Promise<void>) | undefined,
  };
}

/** Create a mock MonitoringDetector */
function createMockMonitoringDetector(): any {
  return {
    detect: async (): Promise<any[]> => [],
  };
}

/** Create a mock SupervisorBus */
function createMockBus(): any {
  const events: Array<{ type: string; reason: string }> = [];
  return {
    emit: async (event: { type: string; reason: string }) => {
      events.push(event);
    },
    getEvents: () => events,
  };
}

/** Create a ContinuousEnforcementLoop with mocked dependencies */
function createTestLoop(overrides?: Partial<EnforcementLoopOptions>) {
  const bus = createMockBus();
  const loop = new ContinuousEnforcementLoop({
    stealthManager: createMockStealthManager() as any,
    monitoringDetector: createMockMonitoringDetector() as any,
    bus: bus as any,
    intervals: {
      windowProtectionMs: 100000, // Very long to avoid timer firing during tests
      processDetectionMs: 100000,
      disguiseValidationMs: 100000,
    },
    logger: silentLogger,
    ...overrides,
  });
  return { loop, bus };
}

/**
 * Simulates the AppState serialized lifecycle pattern:
 * Uses a promise chain (enforcementLoopTransition) to serialize start/stop calls,
 * preventing double-start on rapid enable/disable toggling.
 */
class LifecycleSerializer {
  private transition: Promise<void> = Promise.resolve();
  private running = false;
  readonly loop: ContinuousEnforcementLoop;

  constructor(loop: ContinuousEnforcementLoop) {
    this.loop = loop;
  }

  start(): void {
    const transition = this.transition.then(async () => {
      if (this.running) return;
      this.running = true;
      this.loop.start();
    });
    this.transition = transition.catch(() => {
      this.running = false;
    });
  }

  stop(): void {
    const transition = this.transition.then(async () => {
      if (!this.running) return;
      this.running = false;
      this.loop.stop();
    });
    this.transition = transition.catch(() => {});
  }

  isRunning(): boolean {
    return this.running;
  }

  async waitForTransitions(): Promise<void> {
    await this.transition;
  }
}

// --- Property Tests ---

describe('Feature: stealth-hardening-quickwins, Property 7: Lifecycle Serialization', () => {
  /**
   * Validates: Requirements 2B.1
   *
   * For any sequence of rapid stealth enable/disable toggles, the
   * ContinuousEnforcementLoop SHALL never be in a double-started state —
   * at most one instance of the loop SHALL be running at any time.
   */
  test('no double-started state on rapid toggles', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a random sequence of start/stop operations (true = start, false = stop)
        fc.array(fc.boolean(), { minLength: 2, maxLength: 30 }),
        async (operations) => {
          const { loop } = createTestLoop();
          const serializer = new LifecycleSerializer(loop);

          // Track how many times start() was called without a matching stop()
          let startCount = 0;
          let maxConcurrentStarts = 0;

          // Wrap the loop's start/stop to track concurrent starts
          const originalStart = loop.start.bind(loop);
          const originalStop = loop.stop.bind(loop);

          loop.start = () => {
            startCount++;
            maxConcurrentStarts = Math.max(maxConcurrentStarts, startCount);
            originalStart();
          };

          loop.stop = () => {
            startCount = Math.max(0, startCount - 1);
            originalStop();
          };

          // Fire all operations rapidly (simulating rapid toggling)
          for (const op of operations) {
            if (op) {
              serializer.start();
            } else {
              serializer.stop();
            }
          }

          // Wait for all serialized transitions to complete
          await serializer.waitForTransitions();

          // The loop should never have been started more than once concurrently
          assert.equal(
            maxConcurrentStarts <= 1,
            true,
            `Max concurrent starts was ${maxConcurrentStarts}, expected at most 1`,
          );

          // Final state: loop.isRunning() should match the serializer's running state
          assert.equal(
            loop.isRunning(),
            serializer.isRunning(),
            `Loop running state (${loop.isRunning()}) should match serializer (${serializer.isRunning()})`,
          );

          // Cleanup
          loop.stop();
        },
      ),
      { numRuns: 20 },
    );
  });

  test('rapid enable-disable-enable never produces double-start', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate sequences that always start with enable (true)
        fc.array(fc.boolean(), { minLength: 3, maxLength: 20 }).map((ops) => [true, ...ops]),
        async (operations) => {
          const { loop } = createTestLoop();
          const serializer = new LifecycleSerializer(loop);

          // Apply all operations rapidly
          for (const op of operations) {
            if (op) {
              serializer.start();
            } else {
              serializer.stop();
            }
          }

          await serializer.waitForTransitions();

          // After all transitions settle, the loop's internal running flag
          // should be consistent — it should never be "running" if the
          // serializer says it's stopped, and vice versa
          assert.equal(
            loop.isRunning(),
            serializer.isRunning(),
            'Loop and serializer running states must be consistent after all transitions settle',
          );

          // Cleanup
          loop.stop();
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 8: Kill-Switch Hide Precedence', () => {
  /**
   * Validates: Requirements 2B.3
   *
   * For any interleaving of kill-switch hide-all-windows operations and
   * user-initiated window-show operations, when a kill-switch enforcement
   * epoch is active, the final window visibility state SHALL be hidden.
   *
   * The enforcement epoch mechanism ensures that:
   * - triggerKillSwitch() increments the epoch
   * - shouldSuppressShow(showEpoch) returns true when current epoch > showEpoch
   * - This means any show operation initiated before or during a kill-switch
   *   will be suppressed
   */
  test('hide wins over show during active epoch', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Number of kill-switch triggers
        fc.integer({ min: 1, max: 10 }),
        // Number of show attempts interleaved
        fc.integer({ min: 1, max: 10 }),
        // Order of operations: true = kill-switch trigger, false = show attempt
        fc.array(fc.boolean(), { minLength: 2, maxLength: 20 }),
        async (killSwitchCount, showAttemptCount, interleaving) => {
          let hideCallCount = 0;
          let warningCallCount = 0;

          const { loop } = createTestLoop({
            killSwitch: {
              strictMode: false,
              hideAllWindows: () => {
                hideCallCount++;
              },
              showWarning: () => {
                warningCallCount++;
              },
              quit: () => {},
            },
          });

          loop.start();

          // Track show epochs captured before kill-switch triggers
          const showEpochs: number[] = [];
          let killSwitchTriggers = 0;
          let showAttempts = 0;

          for (const op of interleaving) {
            if (op && killSwitchTriggers < killSwitchCount) {
              // Trigger kill-switch (non-strict mode: hides windows, increments epoch)
              await loop.triggerKillSwitch(`test-reason-${killSwitchTriggers}`);
              killSwitchTriggers++;
            } else if (!op && showAttempts < showAttemptCount) {
              // Simulate a user-initiated show: capture the epoch at show time
              showEpochs.push(loop.getEnforcementEpoch());
              showAttempts++;
            }
          }

          // After all operations, verify the epoch-based precedence:
          // Any show operation whose epoch is less than the current enforcement epoch
          // should be suppressed (hide wins)
          const currentEpoch = loop.getEnforcementEpoch();

          for (const showEpoch of showEpochs) {
            if (showEpoch < currentEpoch) {
              // This show was initiated before or during a kill-switch —
              // shouldSuppressShow must return true (hide wins)
              assert.equal(
                loop.shouldSuppressShow(showEpoch),
                true,
                `Show at epoch ${showEpoch} should be suppressed (current epoch: ${currentEpoch})`,
              );
            }
          }

          // The enforcement epoch should equal the number of kill-switch triggers
          assert.equal(
            currentEpoch,
            killSwitchTriggers,
            `Enforcement epoch (${currentEpoch}) should equal kill-switch triggers (${killSwitchTriggers})`,
          );

          // Each kill-switch trigger should have called hideAllWindows
          assert.equal(
            hideCallCount,
            killSwitchTriggers,
            `hideAllWindows should have been called ${killSwitchTriggers} times, got ${hideCallCount}`,
          );

          // Cleanup
          loop.stop();
        },
      ),
      { numRuns: 20 },
    );
  });

  test('show operations at same epoch as kill-switch are suppressed', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Number of kill-switch triggers before the show attempt
        fc.integer({ min: 1, max: 5 }),
        async (numTriggers) => {
          const { loop } = createTestLoop({
            killSwitch: {
              strictMode: false,
              hideAllWindows: () => {},
              showWarning: () => {},
              quit: () => {},
            },
          });

          loop.start();

          // Capture epoch before any kill-switch
          const showEpochBefore = loop.getEnforcementEpoch();

          // Trigger kill-switch multiple times
          for (let i = 0; i < numTriggers; i++) {
            await loop.triggerKillSwitch(`trigger-${i}`);
          }

          // The show operation captured before the kill-switch should be suppressed
          assert.equal(
            loop.shouldSuppressShow(showEpochBefore),
            true,
            `Show at epoch ${showEpochBefore} must be suppressed after ${numTriggers} kill-switch triggers`,
          );

          // A show operation captured at the current epoch should NOT be suppressed
          // (it was initiated after the kill-switch resolved)
          const showEpochAfter = loop.getEnforcementEpoch();
          assert.equal(
            loop.shouldSuppressShow(showEpochAfter),
            false,
            `Show at current epoch ${showEpochAfter} should NOT be suppressed`,
          );

          // Cleanup
          loop.stop();
        },
      ),
      { numRuns: 20 },
    );
  });

  test('epoch monotonically increases with each kill-switch trigger', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 15 }),
        async (numTriggers) => {
          const { loop } = createTestLoop({
            killSwitch: {
              strictMode: false,
              hideAllWindows: () => {},
              showWarning: () => {},
              quit: () => {},
            },
          });

          loop.start();

          const epochs: number[] = [loop.getEnforcementEpoch()];

          for (let i = 0; i < numTriggers; i++) {
            await loop.triggerKillSwitch(`reason-${i}`);
            epochs.push(loop.getEnforcementEpoch());
          }

          // Verify monotonic increase
          for (let i = 1; i < epochs.length; i++) {
            assert.equal(
              epochs[i] > epochs[i - 1],
              true,
              `Epoch should monotonically increase: epochs[${i}]=${epochs[i]} should be > epochs[${i - 1}]=${epochs[i - 1]}`,
            );
          }

          // Cleanup
          loop.stop();
        },
      ),
      { numRuns: 20 },
    );
  });
});
