import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { StealthTickCoordinator, type TickHandler } from '../stealth/StealthTickCoordinator';
import type { RuntimeLane } from '../config/optimizations';

/**
 * Feature: stealth-hardening-quickwins
 * Property-based tests for StealthTickCoordinator
 *
 * Validates: Requirements 1.2, 1.3, 1B.1, 1B.2, 1B.4, 1B.5, 1.6, 1.7, 1.5, 5B.4
 */

// --- Test Helpers ---

/** Mock RuntimeBudgetScheduler that executes functions directly (synchronously returns promise) */
function createMockScheduler() {
  return {
    submit(_lane: RuntimeLane, fn: () => Promise<void>): Promise<void> {
      return fn();
    },
  };
}

/** Silent logger for tests */
const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

/** Create a coordinator with mock scheduler */
function createTestCoordinator(baseTickMs = 250) {
  const scheduler = createMockScheduler();
  return new StealthTickCoordinator({
    budgetScheduler: scheduler as any,
    baseTickMs,
    logger: silentLogger,
  });
}

/** Arbitrary for valid cadence values [1, 240] */
const cadenceArb = fc.integer({ min: 1, max: 240 });

/** Arbitrary for invalid cadence values (outside [1, 240]) */
const invalidCadenceArb = fc.oneof(
  fc.integer({ min: -1000, max: 0 }),
  fc.integer({ min: 241, max: 10000 }),
);

/** Arbitrary for handler IDs */
const handlerIdArb = fc.string({ minLength: 1, maxLength: 32 }).filter((s) => s.trim().length > 0);

/** Arbitrary for lanes */
const laneArb: fc.Arbitrary<RuntimeLane> = fc.constantFrom(
  'realtime' as RuntimeLane,
  'local-inference' as RuntimeLane,
  'semantic' as RuntimeLane,
  'background' as RuntimeLane,
);

// --- Property Tests ---

describe('Feature: stealth-hardening-quickwins, Property 1: Cadence Dispatch Correctness', () => {
  /**
   * Validates: Requirements 1.2
   *
   * For any valid handler registration with cadence c in [1, 240],
   * after N ticks of the coordinator, the handler SHALL have been invoked
   * exactly floor(N / c) times (minus any skips due to per-id serialization).
   */
  test('handler invoked floor(N/c) times after N ticks', async () => {
    await fc.assert(
      fc.asyncProperty(
        cadenceArb,
        fc.integer({ min: 1, max: 50 }),
        laneArb,
        async (cadence, targetTicks, lane) => {
          const coordinator = createTestCoordinator(1); // 1ms tick
          let invokeCount = 0;

          coordinator.register({
            id: 'cadence-test',
            cadence,
            lane,
            fn: () => {
              invokeCount++;
            },
          });

          coordinator.start();

          // Wait until enough ticks have fired
          const deadline = Date.now() + targetTicks * 5 + 200;
          while (coordinator.getTickCount() < targetTicks && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }

          coordinator.stop();

          // Allow async dispatch chains to settle
          await new Promise((resolve) => setTimeout(resolve, 30));

          const tickCount = coordinator.getTickCount();
          const expectedInvocations = Math.floor(tickCount / cadence);

          assert.equal(
            invokeCount,
            expectedInvocations,
            `cadence=${cadence}, ticks=${tickCount}, expected=${expectedInvocations}, got=${invokeCount}`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 2: Per-ID Serialization', () => {
  /**
   * Validates: Requirements 1.3, 1B.4, 1B.5
   *
   * For any registered handler, at no point in time SHALL two concurrent
   * executions of that handler (identified by the same ID) be in progress
   * simultaneously, regardless of handler execution duration.
   */
  test('no concurrent executions of same handler ID', async (t) => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 5, max: 30 }),
        laneArb,
        async (cadence, totalTicks, lane) => {
          const coordinator = createTestCoordinator(1);
          let concurrentCount = 0;
          let maxConcurrent = 0;
          let resolvers: Array<() => void> = [];

          coordinator.register({
            id: 'serial-test',
            cadence,
            lane,
            fn: async () => {
              concurrentCount++;
              maxConcurrent = Math.max(maxConcurrent, concurrentCount);
              // Simulate long-running async work
              await new Promise<void>((resolve) => {
                resolvers.push(resolve);
              });
              concurrentCount--;
            },
          });

          coordinator.start();

          // Let ticks fire
          await new Promise((resolve) => setTimeout(resolve, totalTicks * 2 + 20));

          coordinator.stop();

          // Resolve all pending handlers
          for (const resolve of resolvers) {
            resolve();
          }
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Per-id serialization means at most 1 concurrent execution
          assert.equal(
            maxConcurrent <= 1,
            true,
            `Max concurrent executions was ${maxConcurrent}, expected at most 1`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 3: Dispatch-Time Mutation Safety', () => {
  /**
   * Validates: Requirements 1B.1, 1B.2
   *
   * For any handler registration or deregistration that occurs during an active
   * dispatch cycle, the handler list SHALL remain consistent — no handlers are
   * lost, duplicated, skipped, or double-invoked within that cycle.
   */
  test('register/deregister during dispatch preserves consistency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 5, max: 20 }),
        laneArb,
        async (numHandlers, targetTicks, lane) => {
          const coordinator = createTestCoordinator(1);
          const invocations: string[] = [];
          let dynamicRegistered = false;

          // Register initial handlers
          for (let i = 0; i < numHandlers; i++) {
            const handlerId = `handler-${i}`;
            coordinator.register({
              id: handlerId,
              cadence: 1,
              lane,
              fn: () => {
                invocations.push(handlerId);
                // During dispatch of handler-0, register a new handler and deregister last
                if (!dynamicRegistered && handlerId === 'handler-0') {
                  dynamicRegistered = true;
                  coordinator.register({
                    id: 'dynamic-handler',
                    cadence: 1,
                    lane,
                    fn: () => {
                      invocations.push('dynamic-handler');
                    },
                  });
                  if (numHandlers > 1) {
                    coordinator.deregister(`handler-${numHandlers - 1}`);
                  }
                }
              },
            });
          }

          coordinator.start();
          await new Promise((resolve) => setTimeout(resolve, targetTicks * 2 + 30));
          coordinator.stop();
          await new Promise((resolve) => setTimeout(resolve, 20));

          // Verify: dynamic handler was eventually invoked
          const hasDynamic = invocations.includes('dynamic-handler');
          assert.equal(hasDynamic, true, 'Dynamic handler should have been invoked after registration');

          // Verify handler count is consistent
          const expectedCount = numHandlers > 1 ? numHandlers : numHandlers + 1;
          assert.equal(
            coordinator.getHandlerCount(),
            expectedCount,
            `Handler count should be ${expectedCount} after mutations`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 4: Error Isolation', () => {
  /**
   * Validates: Requirements 1.6
   *
   * For any set of registered handlers where a subset throws synchronous
   * exceptions or returns rejected Promises, all non-throwing handlers SHALL
   * continue to be dispatched at their correct cadence without interruption.
   */
  test('throwing handlers do not disrupt others', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 0, max: 5 }),
        laneArb,
        async (numHandlers, targetTicks, throwingIndex, lane) => {
          const coordinator = createTestCoordinator(1);
          const counts: Record<string, number> = {};
          const throwIdx = throwingIndex % numHandlers;

          for (let i = 0; i < numHandlers; i++) {
            const id = `handler-${i}`;
            counts[id] = 0;
            coordinator.register({
              id,
              cadence: 1,
              lane,
              fn: () => {
                counts[id]++;
                if (i === throwIdx) {
                  throw new Error(`Handler ${i} intentional error`);
                }
              },
            });
          }

          coordinator.start();
          await new Promise((resolve) => setTimeout(resolve, targetTicks * 2 + 30));
          coordinator.stop();
          await new Promise((resolve) => setTimeout(resolve, 20));

          const tickCount = coordinator.getTickCount();

          // All non-throwing handlers should have been invoked tickCount times
          for (let i = 0; i < numHandlers; i++) {
            if (i !== throwIdx) {
              assert.equal(
                counts[`handler-${i}`],
                tickCount,
                `Non-throwing handler-${i} should have been invoked ${tickCount} times, got ${counts[`handler-${i}`]}`,
              );
            }
          }

          // The throwing handler should also have been invoked (it throws after incrementing)
          assert.equal(
            counts[`handler-${throwIdx}`],
            tickCount,
            `Throwing handler should still be invoked each tick`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 5: Cadence Validation', () => {
  /**
   * Validates: Requirements 1.7
   *
   * Handler registration SHALL succeed if and only if 1 <= cadence <= 240.
   * Values outside this range SHALL be rejected with RangeError.
   */
  test('only cadences in [1, 240] accepted', () => {
    fc.assert(
      fc.property(cadenceArb, laneArb, (cadence, lane) => {
        const coordinator = createTestCoordinator();
        // Valid cadence should not throw
        coordinator.register({
          id: `valid-${cadence}`,
          cadence,
          lane,
          fn: () => {},
        });
        assert.equal(coordinator.getHandlerCount() > 0, true);
      }),
      { numRuns: 20 },
    );
  });

  test('cadences outside [1, 240] rejected with RangeError', () => {
    fc.assert(
      fc.property(invalidCadenceArb, laneArb, (cadence, lane) => {
        const coordinator = createTestCoordinator();
        assert.throws(
          () => {
            coordinator.register({
              id: `invalid-${cadence}`,
              cadence,
              lane,
              fn: () => {},
            });
          },
          RangeError,
          `Cadence ${cadence} should be rejected`,
        );
      }),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 6: Idempotent Start/Stop', () => {
  /**
   * Validates: Requirements 1.5
   *
   * For any sequence of start() and stop() calls, repeated calls to the same
   * method SHALL have no additional effect.
   */
  test('repeated start/stop calls are no-ops', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (operations) => {
          const coordinator = createTestCoordinator(100000); // very long tick to avoid firing

          for (const op of operations) {
            if (op) {
              coordinator.start();
            } else {
              coordinator.stop();
            }
          }

          // The final state should match the last operation
          const lastOp = operations[operations.length - 1];
          assert.equal(
            coordinator.isRunning(),
            lastOp,
            `After operations [${operations.map((o) => (o ? 'start' : 'stop')).join(',')}], isRunning should be ${lastOp}`,
          );

          // Cleanup
          coordinator.stop();
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('Feature: stealth-hardening-quickwins, Property 14: Sequential Dispatch Within Tick', () => {
  /**
   * Validates: Requirements 5B.4
   *
   * For any set of handlers scheduled for the same tick, the tick coordinator
   * SHALL dispatch them sequentially — no two handlers from the same tick
   * SHALL execute concurrently within that tick's dispatch loop.
   */
  test('same-tick handlers dispatched sequentially', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        laneArb,
        async (numHandlers, lane) => {
          // Use a long tick interval so only one tick fires
          const coordinator = createTestCoordinator(50);
          let concurrentCount = 0;
          let maxConcurrent = 0;
          const executionOrder: number[] = [];

          // All handlers have cadence=1, so they all fire on the first tick
          for (let i = 0; i < numHandlers; i++) {
            coordinator.register({
              id: `seq-handler-${i}`,
              cadence: 1,
              lane,
              fn: async () => {
                concurrentCount++;
                maxConcurrent = Math.max(maxConcurrent, concurrentCount);
                executionOrder.push(i);
                // Yield to event loop to detect concurrency violations
                await new Promise<void>((resolve) => setImmediate(resolve));
                concurrentCount--;
              },
            });
          }

          coordinator.start();

          // Wait for the first tick to fire and all handlers to complete
          // First tick fires at 50ms, handlers use setImmediate (microtask-level)
          await new Promise((resolve) => setTimeout(resolve, 80));

          coordinator.stop();

          // Allow any remaining async work to settle
          await new Promise((resolve) => setTimeout(resolve, 20));

          // Within a single tick, no two handlers should have been concurrent
          assert.equal(
            maxConcurrent <= 1,
            true,
            `Max concurrent was ${maxConcurrent}, expected at most 1 (sequential dispatch within tick)`,
          );

          // All handlers should have been invoked at least once
          assert.equal(
            executionOrder.length >= numHandlers,
            true,
            `Expected at least ${numHandlers} handler executions, got ${executionOrder.length}`,
          );
        },
      ),
      { numRuns: 20 },
    );
  });
});
