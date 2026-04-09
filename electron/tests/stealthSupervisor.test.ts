import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { StealthSupervisor } from '../runtime/StealthSupervisor';

function createBus() {
  return new SupervisorBus({ error() {} });
}

test('StealthSupervisor arms and disarms through the delegate while emitting state changes', async () => {
  const calls: boolean[] = [];
  const events: Array<{ from: string; to: string }> = [];
  const bus = createBus();
  bus.subscribe('stealth:state-changed', async (event) => {
    events.push({ from: event.from, to: event.to });
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
    },
    bus,
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');
  await supervisor.setEnabled(false);
  assert.equal(supervisor.getStealthState(), 'OFF');

  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(events, [
    { from: 'OFF', to: 'ARMING' },
    { from: 'ARMING', to: 'FULL_STEALTH' },
    { from: 'FULL_STEALTH', to: 'OFF' },
  ]);
});

test('StealthSupervisor fails closed when arm verification fails', async () => {
  const delegateCalls: boolean[] = [];
  const faultReasons: string[] = [];
  const bus = createBus();
  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        delegateCalls.push(enabled);
      },
      isEnabled: () => false,
    },
    bus,
    {
      verifier: () => false,
    },
  );

  await supervisor.start();
  await assert.rejects(() => supervisor.setEnabled(true), /stealth verification failed/);
  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(delegateCalls, [true, false]);
  assert.deepEqual(faultReasons, ['stealth verification failed']);
});

test('StealthSupervisor stop disables stealth and returns to idle', async () => {
  const calls: boolean[] = [];
  const bus = createBus();
  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
    },
    bus,
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  await supervisor.stop();

  assert.equal(supervisor.getState(), 'idle');
  assert.equal(supervisor.getStealthState(), 'OFF');
  assert.deepEqual(calls, [true, false]);
});

test('StealthSupervisor propagates delegate failures as faults', async () => {
  const faultReasons: string[] = [];
  const events: Array<{ from: string; to: string }> = [];
  const bus = createBus();
  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });
  bus.subscribe('stealth:state-changed', async (event) => {
    events.push({ from: event.from, to: event.to });
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        if (enabled) {
          throw new Error('native module absent');
        }
      },
    },
    bus,
  );

  await supervisor.start();
  await assert.rejects(() => supervisor.setEnabled(true), /native module absent/);

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(faultReasons, ['native module absent']);
  assert.deepEqual(events, [
    { from: 'OFF', to: 'ARMING' },
    { from: 'ARMING', to: 'FAULT' },
  ]);
});
