import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { StealthSupervisor } from '../runtime/StealthSupervisor';
import { NativeStealthBridge, type NativeStealthBridgeClient } from '../stealth/NativeStealthBridge';
import type {
  MacosLayer3Blocker,
  MacosLayer3HealthReport,
  MacosLayer3ResponseEnvelope,
  MacosLayer3SessionState,
} from '../stealth/separateProjectContracts';

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
  const clearedHandles: unknown[] = [];
  const heartbeatHandle = { unref() {} };
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
      intervalScheduler: () => heartbeatHandle,
      clearIntervalScheduler: (handle) => {
        clearedHandles.push(handle);
      },
    },
  );

  await supervisor.start();
  await assert.rejects(() => supervisor.setEnabled(true), /stealth verification failed/);
  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(delegateCalls, [true]);
  assert.deepEqual(faultReasons, ['stealth verification failed']);
  assert.deepEqual(clearedHandles, []);
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

test('StealthSupervisor can be faulted explicitly after it is armed', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const clearedHandles: unknown[] = [];
  const heartbeatHandle = { unref() {} };
  const bus = createBus();
  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
    },
    bus,
    {
      intervalScheduler: () => heartbeatHandle,
      clearIntervalScheduler: (handle) => {
        clearedHandles.push(handle);
      },
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  await supervisor.reportFault(new Error('window_visible_to_capture'));

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, ['window_visible_to_capture']);
  assert.deepEqual(clearedHandles, [heartbeatHandle]);
});

test('StealthSupervisor enters FAULT when heartbeat verification misses', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const bus = createBus();
  const heartbeatTicks: Array<() => void> = [];
  const clearedHandles: unknown[] = [];
  const heartbeatHandle = { unref() {} };
  let verifyCallCount = 0;

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
    },
    bus,
    {
      verifier: () => {
        verifyCallCount += 1;
        return verifyCallCount === 1;
      },
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        return heartbeatHandle;
      },
      clearIntervalScheduler: (handle) => {
        clearedHandles.push(handle);
      },
      heartbeatIntervalMs: 1,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');
  assert.equal(heartbeatTicks.length, 1);

  heartbeatTicks[0]();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, ['stealth heartbeat missed']);
  assert.deepEqual(clearedHandles, [heartbeatHandle]);
});

test('StealthSupervisor clears heartbeat timer during normal disable and stop', async () => {
  const calls: boolean[] = [];
  const bus = createBus();
  const heartbeatTicks: Array<() => void> = [];
  const clearedHandles: unknown[] = [];
  const firstHandle = { id: 1, unref() {} };
  const secondHandle = { id: 2, unref() {} };
  let scheduleCount = 0;

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        scheduleCount += 1;
        return scheduleCount === 1 ? firstHandle : secondHandle;
      },
      clearIntervalScheduler: (handle) => {
        clearedHandles.push(handle);
      },
      heartbeatIntervalMs: 1,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  await supervisor.setEnabled(false);
  await supervisor.setEnabled(true);
  await supervisor.stop();

  assert.deepEqual(calls, [true, false, true, false]);
  assert.equal(heartbeatTicks.length, 2);
  assert.deepEqual(clearedHandles, [firstHandle, secondHandle]);
  assert.equal(supervisor.getState(), 'idle');
  assert.equal(supervisor.getStealthState(), 'OFF');
});

test('StealthSupervisor serializes rapid on-off-on toggles without faulting', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const bus = createBus();
  let releaseEnable: (() => void) | null = null;
  const enableGate = new Promise<void>((resolve) => {
    releaseEnable = resolve;
  });

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
        if (enabled && calls.length === 1) {
          await enableGate;
        }
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
  );

  await supervisor.start();

  const first = supervisor.setEnabled(true);
  const second = supervisor.setEnabled(false);
  const third = supervisor.setEnabled(true);

  releaseEnable?.();

  await Promise.all([first, second, third]);

  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');
  assert.deepEqual(calls, [true, false, true]);
  assert.deepEqual(faultReasons, []);
});

test('StealthSupervisor transitions to FAULT when native heartbeat reports unhealthy helper', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const bus = createBus();
  const heartbeatTicks: Array<() => void> = [];

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge: {
        arm: async () => ({ connected: true, sessionId: 'session-a', surfaceId: 'surface-a' }),
        heartbeat: async () => ({ connected: true, healthy: false }),
        fault: async () => {},
      } as unknown as import('../stealth/NativeStealthBridge').NativeStealthBridge,
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        return { unref() {} };
      },
      clearIntervalScheduler: () => {},
      heartbeatIntervalMs: 1,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, ['stealth heartbeat missed']);
});

test('StealthSupervisor fails closed when the native helper proactively reports a fault', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const bus = createBus();
  let helperFaultHandler: ((reason: string) => void | Promise<void>) | undefined;

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge: {
        arm: async () => ({ connected: true, sessionId: 'session-proactive-fault', surfaceId: 'surface-proactive-fault' }),
        heartbeat: async () => ({ connected: true, healthy: true }),
        fault: async () => {},
        setHelperFaultHandler(handler: ((reason: string) => void | Promise<void>) | undefined) {
          helperFaultHandler = handler;
        },
      } as unknown as import('../stealth/NativeStealthBridge').NativeStealthBridge,
      heartbeatIntervalMs: 0,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  await helperFaultHandler?.('stealth-heartbeat-missed');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, ['stealth-heartbeat-missed']);
});

test('StealthSupervisor falls back to Electron-only stealth when native helper is unavailable', async () => {
  const calls: boolean[] = [];
  const bus = createBus();

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge: {
        arm: async () => ({ connected: false, sessionId: null as string | null, surfaceId: null as string | null }),
        heartbeat: async () => ({ connected: false, healthy: false }),
        fault: async () => {},
      } as unknown as import('../stealth/NativeStealthBridge').NativeStealthBridge,
      heartbeatIntervalMs: 0,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);

  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');
  assert.deepEqual(calls, [true]);
});

test('StealthSupervisor stays in FULL_STEALTH after a native helper sleep/wake cycle when the bridge restart succeeds', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const heartbeatTicks: Array<() => void> = [];
  const bus = createBus();
  let clientGeneration = 0;
  let createCalls = 0;

  const healthyEnvelope = (sessionId: string, presenting: boolean): MacosLayer3ResponseEnvelope<MacosLayer3HealthReport> => ({
    outcome: 'ok' as const,
    failClosed: false,
    presentationAllowed: presenting,
    blockers: [] as MacosLayer3Blocker[],
    data: {
      sessionId,
      state: (presenting ? 'presenting' : 'attached') as MacosLayer3SessionState,
      surfaceAttached: true,
      presenting,
      recoveryPending: false,
      blockers: [] as MacosLayer3Blocker[],
      lastTransitionAt: new Date(0).toISOString(),
    },
  });

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const nativeBridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-sleep-wake',
    waitForRestartBackoff: async () => {},
    clientFactory: (): NativeStealthBridgeClient => {
      clientGeneration += 1;
      let healthCalls = 0;

      return {
        async createProtectedSession(request) {
          createCalls += 1;
          return {
            outcome: 'ok',
            failClosed: false,
            presentationAllowed: true,
            blockers: [] as MacosLayer3Blocker[],
            data: { sessionId: request.sessionId, state: 'creating' as const },
          };
        },
        async attachSurface(request) {
          return healthyEnvelope(request.sessionId, false);
        },
        async present(request) {
          return healthyEnvelope(request.sessionId, request.activate);
        },
        async getHealth() {
          healthCalls += 1;
          if (clientGeneration === 1 && healthCalls === 1) {
            throw new Error('sleep-wake-disconnect');
          }

          return healthyEnvelope('session-sleep-wake', true);
        },
        async teardownSession() {
          return {
            outcome: 'ok',
            failClosed: false,
            presentationAllowed: false,
            blockers: [] as MacosLayer3Blocker[],
            data: { released: true },
          };
        },
        dispose() {},
      };
    },
    logger: { warn() {} },
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge,
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        return { unref() {} };
      },
      clearIntervalScheduler: () => {},
      heartbeatIntervalMs: 1,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, []);
  assert.equal(createCalls, 2);
});

test('StealthSupervisor can recover from a second native helper disconnect while restart budget remains', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const heartbeatTicks: Array<() => void> = [];
  const bus = createBus();
  let clientGeneration = 0;
  let createCalls = 0;

  const healthyEnvelope = (sessionId: string, presenting: boolean): MacosLayer3ResponseEnvelope<MacosLayer3HealthReport> => ({
    outcome: 'ok' as const,
    failClosed: false,
    presentationAllowed: presenting,
    blockers: [] as MacosLayer3Blocker[],
    data: {
      sessionId,
      state: (presenting ? 'presenting' : 'attached') as MacosLayer3SessionState,
      surfaceAttached: true,
      presenting,
      recoveryPending: false,
      blockers: [] as MacosLayer3Blocker[],
      lastTransitionAt: new Date(0).toISOString(),
    },
  });

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const nativeBridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-display-hotplug',
    waitForRestartBackoff: async () => {},
    clientFactory: (): NativeStealthBridgeClient => {
      clientGeneration += 1;
      let healthCalls = 0;

      return {
        async createProtectedSession(request) {
          createCalls += 1;
          return {
            outcome: 'ok',
            failClosed: false,
            presentationAllowed: true,
            blockers: [] as MacosLayer3Blocker[],
            data: { sessionId: request.sessionId, state: 'creating' as const },
          };
        },
        async attachSurface(request) {
          return healthyEnvelope(request.sessionId, false);
        },
        async present(request) {
          return healthyEnvelope(request.sessionId, request.activate);
        },
        async getHealth() {
          healthCalls += 1;
          if (clientGeneration === 1 && healthCalls === 1) {
            throw new Error('sleep-wake-disconnect');
          }

          if (clientGeneration === 2 && healthCalls === 2) {
            throw new Error('display-hotplug-disconnect');
          }

          return healthyEnvelope('session-display-hotplug', true);
        },
        async teardownSession() {
          return {
            outcome: 'ok',
            failClosed: false,
            presentationAllowed: false,
            blockers: [] as MacosLayer3Blocker[],
            data: { released: true },
          };
        },
        dispose() {},
      };
    },
    logger: { warn() {} },
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge,
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        return { unref() {} };
      },
      clearIntervalScheduler: () => {},
      heartbeatIntervalMs: 1,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);

  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, []);
  assert.equal(createCalls, 3);
});

test('StealthSupervisor fails closed once the native helper disconnects after exhausting restart budget', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const heartbeatTicks: Array<() => void> = [];
  const bus = createBus();
  let clientGeneration = 0;
  let createCalls = 0;

  const healthyEnvelope = (sessionId: string, presenting: boolean): MacosLayer3ResponseEnvelope<MacosLayer3HealthReport> => ({
    outcome: 'ok' as const,
    failClosed: false,
    presentationAllowed: presenting,
    blockers: [] as MacosLayer3Blocker[],
    data: {
      sessionId,
      state: (presenting ? 'presenting' : 'attached') as MacosLayer3SessionState,
      surfaceAttached: true,
      presenting,
      recoveryPending: false,
      blockers: [] as MacosLayer3Blocker[],
      lastTransitionAt: new Date(0).toISOString(),
    },
  });

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const nativeBridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-display-hotplug-exhausted',
    waitForRestartBackoff: async () => {},
    clientFactory: (): NativeStealthBridgeClient => {
      clientGeneration += 1;
      let healthCalls = 0;

      return {
        async createProtectedSession(request) {
          createCalls += 1;
          return {
            outcome: 'ok',
            failClosed: false,
            presentationAllowed: true,
            blockers: [] as MacosLayer3Blocker[],
            data: { sessionId: request.sessionId, state: 'creating' as const },
          };
        },
        async attachSurface(request) {
          return healthyEnvelope(request.sessionId, false);
        },
        async present(request) {
          return healthyEnvelope(request.sessionId, request.activate);
        },
        async getHealth() {
          healthCalls += 1;
          if (clientGeneration === 1 && healthCalls === 1) {
            throw new Error('sleep-wake-disconnect');
          }

          if (clientGeneration === 2 && healthCalls === 2) {
            throw new Error('display-hotplug-disconnect');
          }

          if (clientGeneration === 3 && healthCalls === 2) {
            throw new Error('third-disconnect');
          }

          return healthyEnvelope('session-display-hotplug-exhausted', true);
        },
        async teardownSession() {
          return {
            outcome: 'ok',
            failClosed: false,
            presentationAllowed: false,
            blockers: [] as MacosLayer3Blocker[],
            data: { released: true },
          };
        },
        dispose() {},
      };
    },
    logger: { warn() {} },
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge,
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        return { unref() {} };
      },
      clearIntervalScheduler: () => {},
      heartbeatIntervalMs: 1,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);

  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, ['stealth heartbeat missed']);
  assert.equal(createCalls, 3);
});

test('StealthSupervisor fails closed after the native helper disconnects and its one restart attempt fails', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const heartbeatTicks: Array<() => void> = [];
  const bus = createBus();
  let createCalls = 0;
  let healthCalls = 0;

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const nativeBridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-restart-fail',
    waitForRestartBackoff: async () => {},
    clientFactory: () => ({
      async createProtectedSession(request) {
        createCalls += 1;
        if (createCalls > 1) {
          throw new Error('restart-unavailable');
        }

        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: { sessionId: request.sessionId, state: 'creating' },
        };
      },
      async attachSurface(request) {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: 'attached',
            surfaceAttached: true,
            presenting: false,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async present(request) {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: request.activate ? 'presenting' : 'attached',
            surfaceAttached: true,
            presenting: request.activate,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async getHealth() {
        healthCalls += 1;
        if (healthCalls === 1) {
          throw new Error('helper-exit');
        }

        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: 'session-restart-fail',
            state: 'presenting',
            surfaceAttached: true,
            presenting: true,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async teardownSession() {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: false,
          blockers: [],
          data: { released: true },
        };
      },
      dispose() {},
    }),
    logger: { warn() {} },
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge,
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        return { unref() {} };
      },
      clearIntervalScheduler: () => {},
      heartbeatIntervalMs: 1,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, ['stealth heartbeat missed']);
  assert.equal(createCalls, 2);
});

test('StealthSupervisor fails closed when runtime-origin heartbeat becomes stale', async () => {
  const calls: boolean[] = [];
  const faultReasons: string[] = [];
  const heartbeatTicks: Array<() => void> = [];
  const bus = createBus();
  let nowMs = 0;

  bus.subscribe('stealth:fault', async (event) => {
    faultReasons.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      heartbeatIntervalMs: 1,
      intervalScheduler: (callback) => {
        heartbeatTicks.push(callback);
        return { unref() {} };
      },
      clearIntervalScheduler: () => {},
      runtimeHeartbeatStalenessMs: 200,
      now: () => nowMs,
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  supervisor.noteRuntimeHeartbeat();
  nowMs = 100;
  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  nowMs = 450;
  heartbeatTicks[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(calls, [true]);
  assert.deepEqual(faultReasons, ['stealth heartbeat missed']);
});
