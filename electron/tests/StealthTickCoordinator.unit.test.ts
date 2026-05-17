/**
 * Unit tests for StealthTickCoordinator.
 *
 * Validates: Requirements 1.1, 1.4, 1B.3
 *
 * Uses Node.js built-in test runner with fake timers for deterministic tick control.
 * The RuntimeBudgetScheduler is mocked to execute submitted functions directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { StealthTickCoordinator, type TickHandler } from '../stealth/StealthTickCoordinator';
import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';
import type { RuntimeLane } from '../config/optimizations';

/** Mock RuntimeBudgetScheduler that executes submitted functions directly */
function createMockBudgetScheduler(): RuntimeBudgetScheduler {
  return {
    submit: async (_lane: RuntimeLane, fn: () => Promise<void> | void) => {
      await fn();
    },
  } as unknown as RuntimeBudgetScheduler;
}

const silentLogger = { log() {}, warn() {}, error() {} };

function createCoordinator(baseTickMs = 250) {
  return new StealthTickCoordinator({
    budgetScheduler: createMockBudgetScheduler(),
    baseTickMs,
    logger: silentLogger,
  });
}

function createHandler(overrides: Partial<TickHandler> & { fn?: () => Promise<void> | void } = {}): TickHandler {
  return {
    id: overrides.id ?? 'test-handler',
    cadence: overrides.cadence ?? 1,
    lane: overrides.lane ?? 'background',
    fn: overrides.fn ?? (() => {}),
  };
}

// --- Handler Registration and Dispatch with Fake Timers ---

test('handler is dispatched after one tick when cadence is 1', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let callCount = 0;
  coordinator.register(createHandler({ fn: () => { callCount++; } }));
  coordinator.start();

  t.mock.timers.tick(250);
  // Allow microtasks to flush
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callCount, 1, 'handler should be called once after one tick');
  coordinator.stop();
});

test('handler with cadence 4 is dispatched every 4th tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let callCount = 0;
  coordinator.register(createHandler({ cadence: 4, fn: () => { callCount++; } }));
  coordinator.start();

  // Advance 8 ticks (2000ms at 250ms base)
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(250);
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(callCount, 2, 'handler with cadence 4 should fire twice in 8 ticks');
  coordinator.stop();
});

test('multiple handlers with different cadences dispatch correctly', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let countA = 0;
  let countB = 0;

  coordinator.register(createHandler({ id: 'a', cadence: 1, fn: () => { countA++; } }));
  coordinator.register(createHandler({ id: 'b', cadence: 2, fn: () => { countB++; } }));
  coordinator.start();

  // Advance 4 ticks
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(250);
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(countA, 4, 'cadence-1 handler fires every tick');
  assert.equal(countB, 2, 'cadence-2 handler fires every other tick');
  coordinator.stop();
});

test('getHandlerCount reflects registered handlers', () => {
  const coordinator = createCoordinator();
  assert.equal(coordinator.getHandlerCount(), 0);

  coordinator.register(createHandler({ id: 'a' }));
  assert.equal(coordinator.getHandlerCount(), 1);

  coordinator.register(createHandler({ id: 'b' }));
  assert.equal(coordinator.getHandlerCount(), 2);
});

test('getTickCount increments with each tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  coordinator.start();

  assert.equal(coordinator.getTickCount(), 0);

  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getTickCount(), 1);

  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getTickCount(), 2);

  coordinator.stop();
});

// --- Deregistration Stops Future Invocations ---

test('deregistered handler is not invoked on subsequent ticks', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let callCount = 0;
  coordinator.register(createHandler({ id: 'removable', fn: () => { callCount++; } }));
  coordinator.start();

  // First tick — handler fires
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 1);

  // Deregister
  coordinator.deregister('removable');
  assert.equal(coordinator.getHandlerCount(), 0);

  // Second tick — handler should NOT fire
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 1, 'handler should not fire after deregistration');

  coordinator.stop();
});

test('deregistering a non-existent handler does not throw', () => {
  const coordinator = createCoordinator();
  assert.doesNotThrow(() => coordinator.deregister('non-existent'));
});

// --- stop() During Active Dispatch Completes Cycle ---

test('stop() during active dispatch allows current cycle to complete', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let completed = false;

  coordinator.register(createHandler({
    fn: async () => {
      // Simulate async work
      await new Promise((resolve) => setImmediate(resolve));
      completed = true;
    },
  }));
  coordinator.start();

  // Trigger a tick
  t.mock.timers.tick(250);

  // Stop immediately while dispatch is in progress
  coordinator.stop();
  assert.equal(coordinator.isRunning(), false);

  // Allow the async handler to complete
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completed, true, 'handler should complete even after stop()');
});

test('stop() prevents further ticks from firing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let callCount = 0;
  coordinator.register(createHandler({ fn: () => { callCount++; } }));
  coordinator.start();

  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 1);

  coordinator.stop();

  // Advance time — no more ticks should fire
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 1, 'no more invocations after stop()');
});

test('start() after stop() resumes ticking', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let callCount = 0;
  coordinator.register(createHandler({ fn: () => { callCount++; } }));

  coordinator.start();
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 1);

  coordinator.stop();
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 1);

  coordinator.start();
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callCount, 2, 'handler fires again after restart');

  coordinator.stop();
});

// --- Duplicate Handler ID Overwrites Existing ---

test('registering a handler with duplicate ID overwrites the previous handler', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let firstCalled = false;
  let secondCalled = false;

  coordinator.register(createHandler({ id: 'dup', fn: () => { firstCalled = true; } }));
  coordinator.register(createHandler({ id: 'dup', fn: () => { secondCalled = true; } }));

  assert.equal(coordinator.getHandlerCount(), 1, 'duplicate ID should not increase handler count');

  coordinator.start();
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstCalled, false, 'first handler should not be called');
  assert.equal(secondCalled, true, 'second (overwriting) handler should be called');

  coordinator.stop();
});

test('overwriting handler preserves the new cadence', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let callCount = 0;

  // Register with cadence 1
  coordinator.register(createHandler({ id: 'dup', cadence: 1, fn: () => { callCount++; } }));
  // Overwrite with cadence 3
  coordinator.register(createHandler({ id: 'dup', cadence: 3, fn: () => { callCount++; } }));

  coordinator.start();

  // Advance 3 ticks — cadence-3 handler should fire once (at tick 3)
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(250);
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(callCount, 1, 'overwritten handler uses new cadence');
  coordinator.stop();
});

// --- Idempotent start/stop ---

test('start() is idempotent — calling twice does not create duplicate timers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let callCount = 0;
  coordinator.register(createHandler({ fn: () => { callCount++; } }));

  coordinator.start();
  coordinator.start(); // second call should be no-op

  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callCount, 1, 'handler should fire only once per tick despite double start');
  coordinator.stop();
});

test('stop() is idempotent — calling twice does not throw', () => {
  const coordinator = createCoordinator();
  coordinator.start();
  coordinator.stop();
  assert.doesNotThrow(() => coordinator.stop());
});

test('isRunning() reflects lifecycle state', () => {
  const coordinator = createCoordinator();
  assert.equal(coordinator.isRunning(), false);

  coordinator.start();
  assert.equal(coordinator.isRunning(), true);

  coordinator.stop();
  assert.equal(coordinator.isRunning(), false);
});

// --- Cadence Validation ---

test('register rejects cadence below 1', () => {
  const coordinator = createCoordinator();
  assert.throws(
    () => coordinator.register(createHandler({ cadence: 0 })),
    /Invalid cadence 0/,
  );
});

test('register rejects cadence above 240', () => {
  const coordinator = createCoordinator();
  assert.throws(
    () => coordinator.register(createHandler({ cadence: 241 })),
    /Invalid cadence 241/,
  );
});

test('register rejects negative cadence', () => {
  const coordinator = createCoordinator();
  assert.throws(
    () => coordinator.register(createHandler({ cadence: -5 })),
    /Invalid cadence -5/,
  );
});

test('register accepts cadence at boundaries (1 and 240)', () => {
  const coordinator = createCoordinator();
  assert.doesNotThrow(() => coordinator.register(createHandler({ id: 'min', cadence: 1 })));
  assert.doesNotThrow(() => coordinator.register(createHandler({ id: 'max', cadence: 240 })));
  assert.equal(coordinator.getHandlerCount(), 2);
});

// --- Error Isolation ---

test('throwing handler does not prevent other handlers from executing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let healthyCalled = false;

  coordinator.register(createHandler({
    id: 'thrower',
    fn: () => { throw new Error('boom'); },
  }));
  coordinator.register(createHandler({
    id: 'healthy',
    fn: () => { healthyCalled = true; },
  }));

  coordinator.start();
  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(healthyCalled, true, 'healthy handler should still execute');
  coordinator.stop();
});

test('handler returning rejected promise does not disrupt dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const coordinator = createCoordinator();
  let healthyCalled = false;

  coordinator.register(createHandler({
    id: 'rejecter',
    fn: async () => { throw new Error('async boom'); },
  }));
  coordinator.register(createHandler({
    id: 'healthy',
    fn: () => { healthyCalled = true; },
  }));

  coordinator.start();
  t.mock.timers.tick(250);
  // Allow multiple microtask flushes for the promise chain
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(healthyCalled, true, 'healthy handler executes despite rejected promise from sibling');
  coordinator.stop();
});

// --- Lane-aware submission ---

test('handlers are submitted to the correct lane', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const submittedLanes: RuntimeLane[] = [];
  const mockScheduler = {
    submit: async (lane: RuntimeLane, fn: () => Promise<void> | void) => {
      submittedLanes.push(lane);
      await fn();
    },
  } as unknown as RuntimeBudgetScheduler;

  const coordinator = new StealthTickCoordinator({
    budgetScheduler: mockScheduler,
    baseTickMs: 250,
    logger: silentLogger,
  });

  coordinator.register(createHandler({ id: 'rt', lane: 'realtime', fn: () => {} }));
  coordinator.register(createHandler({ id: 'bg', lane: 'background', fn: () => {} }));
  coordinator.start();

  t.mock.timers.tick(250);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(submittedLanes.includes('realtime'), 'realtime lane should be used');
  assert.ok(submittedLanes.includes('background'), 'background lane should be used');
  coordinator.stop();
});
