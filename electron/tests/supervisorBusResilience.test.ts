// electron/tests/supervisorBusResilience.test.ts
//
// NAT-020 / audit R-10: SupervisorBus.emit must not throw on listener
// errors and must auto-unsubscribe a listener that has failed
// LISTENER_FAILURE_THRESHOLD times within LISTENER_FAILURE_WINDOW_MS.
//
// What this pins:
//   1. A throwing listener does not abort emit() — sibling listeners
//      still receive the event.
//   2. Critical events (stealth:fault, lifecycle:meeting-starting,
//      lifecycle:meeting-stopping) no longer rethrow out of emit().
//   3. After 3 consecutive failures inside the 30 s window, the
//      offending listener is auto-unsubscribed and a
//      `bus:listener-circuit-open` event is emitted to subscribed
//      observers.
//   4. The bus survives a listener that fails 5x in a row: the first
//      3 trip the breaker, the next 2 must observe the listener gone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus, LISTENER_FAILURE_THRESHOLD } from '../runtime/SupervisorBus';
import type { SupervisorEvent } from '../runtime/types';

const silentLogger = { error() {}, warn() {} };

test('NAT-020: throwing listener does not interrupt sibling listeners', async () => {
  const bus = new SupervisorBus(silentLogger);
  const observed: string[] = [];
  bus.subscribe('audio:gap-detected', () => {
    throw new Error('boom-1');
  });
  bus.subscribe('audio:gap-detected', (ev) => {
    observed.push(`sibling:${ev.durationMs}`);
  });

  // Must not throw.
  await bus.emit({ type: 'audio:gap-detected', durationMs: 250 });
  assert.deepEqual(observed, ['sibling:250']);
});

test('NAT-020: critical event listener errors no longer rethrow out of emit()', async () => {
  const bus = new SupervisorBus(silentLogger);
  bus.subscribe('lifecycle:meeting-starting', () => {
    throw new Error('startup-listener-failed');
  });

  // The previous behavior threw here and aborted lifecycle progression.
  await bus.emit({ type: 'lifecycle:meeting-starting', meetingId: 'm-1' });
});

test('NAT-020: bus:listener-error meta-event carries the failure detail', async () => {
  const bus = new SupervisorBus(silentLogger);
  const meta: SupervisorEvent[] = [];
  bus.subscribe('audio:gap-detected', () => {
    throw new Error('gap-listener-broke');
  });
  bus.subscribe('bus:listener-error', (ev) => {
    meta.push(ev);
  });

  await bus.emit({ type: 'audio:gap-detected', durationMs: 100 });
  assert.equal(meta.length, 1);
  const ev = meta[0];
  if (ev.type !== 'bus:listener-error') throw new Error('wrong meta type');
  assert.equal(ev.sourceEventType, 'audio:gap-detected');
  assert.equal(ev.failureCount, 1);
  assert.equal(ev.messages[0], 'gap-listener-broke');
  assert.equal(ev.critical, false);
});

test('NAT-020: 3 consecutive failures trip the breaker and emit bus:listener-circuit-open', async () => {
  const bus = new SupervisorBus(silentLogger);
  let calls = 0;
  bus.subscribe('audio:gap-detected', () => {
    calls += 1;
    throw new Error(`fail-${calls}`);
  });
  // Sibling listener that should *keep* getting calls after the breaker
  // trips, proving the breaker is per-listener not per-event-type.
  let sibling = 0;
  bus.subscribe('audio:gap-detected', () => {
    sibling += 1;
  });
  const breakerEvents: SupervisorEvent[] = [];
  bus.subscribe('bus:listener-circuit-open', (ev) => {
    breakerEvents.push(ev);
  });

  for (let i = 0; i < 5; i += 1) {
    await bus.emit({ type: 'audio:gap-detected', durationMs: 10 });
    // give the fire-and-forget meta emit a turn of the microtask queue
    await new Promise<void>((res) => setImmediate(res));
  }

  // The throwing listener should have been called exactly THRESHOLD
  // times — the 3rd call trips it and removes it from the registry,
  // so emits 4 and 5 must NOT call it again.
  assert.equal(calls, LISTENER_FAILURE_THRESHOLD, `expected ${LISTENER_FAILURE_THRESHOLD} failing-listener invocations, got ${calls}`);
  // Sibling keeps receiving every event.
  assert.equal(sibling, 5, 'sibling listener must still receive every event');
  // Exactly one breaker-open event was emitted.
  assert.equal(breakerEvents.length, 1, 'expected exactly one bus:listener-circuit-open');
  const breaker = breakerEvents[0];
  if (breaker.type !== 'bus:listener-circuit-open') throw new Error('wrong meta type');
  assert.equal(breaker.sourceEventType, 'audio:gap-detected');
  assert.equal(breaker.failureCount, LISTENER_FAILURE_THRESHOLD);
  assert.match(breaker.lastErrorMessage, /fail-\d+/);
});
