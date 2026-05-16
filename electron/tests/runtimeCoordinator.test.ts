import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeCoordinator } from '../runtime/RuntimeCoordinator';

test('RuntimeCoordinator activates and deactivates through the lifecycle delegate and emits lifecycle events', async () => {
  const delegateCalls: string[] = [];
  const lifecycleEvents: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {
        delegateCalls.push('start');
      },
      async finalizeMeetingDeactivation() {
        delegateCalls.push('stop');
      },
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  coordinator.getBus().subscribeAll(async (event) => {
    lifecycleEvents.push(event.type);
  });

  await coordinator.activate({ source: 'test' });
  assert.equal(coordinator.getLifecycleState(), 'active');
  await coordinator.deactivate();

  assert.deepEqual(delegateCalls, ['start', 'stop']);
  assert.deepEqual(lifecycleEvents, [
    'lifecycle:meeting-starting',
    'lifecycle:meeting-active',
    'lifecycle:meeting-stopping',
    'lifecycle:meeting-idle',
  ]);
  assert.equal(coordinator.getLifecycleState(), 'idle');
});

test('RuntimeCoordinator rejects invalid activation transitions', async () => {
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {},
      async finalizeMeetingDeactivation() {},
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  await coordinator.activate();
  await assert.rejects(() => coordinator.activate(), /Cannot activate meeting while runtime is active/);
});

test('RuntimeCoordinator resets to idle when activation preparation fails', async () => {
  const lifecycleEvents: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {
        throw new Error('activation failed');
      },
      async finalizeMeetingDeactivation() {},
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  coordinator.getBus().subscribeAll(async (event) => {
    lifecycleEvents.push(event.type);
  });

  await assert.rejects(() => coordinator.activate(), /activation failed/);
  assert.equal(coordinator.getLifecycleState(), 'idle');
  assert.deepEqual(lifecycleEvents, [
    'lifecycle:meeting-starting',
    'lifecycle:meeting-idle',
  ]);
});

test('RuntimeCoordinator manages configured supervisors during activate/deactivate', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {
        calls.push('delegate:start');
      },
      async finalizeMeetingDeactivation() {
        calls.push('delegate:stop');
      },
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: ['recovery', 'audio', 'stt'],
    },
  );

  for (const name of ['recovery', 'audio', 'stt'] as const) {
    coordinator.registerSupervisor({
      name,
      async start() {
        calls.push(`start:${name}`);
      },
      async stop() {
        calls.push(`stop:${name}`);
      },
      getState() {
        return 'idle';
      },
    });
  }

  await coordinator.activate({ source: 'test' });
  await coordinator.deactivate();

  assert.deepEqual(calls, [
    'delegate:start',
    'start:recovery',
    'start:audio',
    'start:stt',
    'stop:stt',
    'stop:audio',
    'stop:recovery',
    'delegate:stop',
  ]);
});

test('RuntimeCoordinator default lifecycle includes inference lane', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {
        calls.push('delegate:start');
      },
      async finalizeMeetingDeactivation() {
        calls.push('delegate:stop');
      },
    },
    { logger: { warn() {} } },
  );

  for (const name of ['recovery', 'audio', 'stt', 'inference'] as const) {
    coordinator.registerSupervisor({
      name,
      async start() {
        calls.push(`start:${name}`);
      },
      async stop() {
        calls.push(`stop:${name}`);
      },
      getState() {
        return 'idle';
      },
    });
  }

  await coordinator.activate({ source: 'test' });
  await coordinator.deactivate();

  assert.deepEqual(calls, [
    'delegate:start',
    'start:recovery',
    'start:audio',
    'start:stt',
    'start:inference',
    'stop:inference',
    'stop:stt',
    'stop:audio',
    'stop:recovery',
    'delegate:stop',
  ]);
});

test('RuntimeCoordinator starts supervisors in order and stops them in reverse order', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {},
      async finalizeMeetingDeactivation() {},
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  for (const name of ['inference', 'audio', 'stt', 'recovery'] as const) {
    coordinator.registerSupervisor({
      name,
      async start() {
        calls.push(`start:${name}`);
      },
      async stop() {
        calls.push(`stop:${name}`);
      },
      getState() {
        return 'idle';
      },
    });
  }

  await coordinator.startSupervisors(['inference', 'audio', 'stt', 'recovery']);
  await coordinator.stopSupervisors(['inference', 'audio', 'stt', 'recovery']);

  assert.deepEqual(calls, [
    'start:inference',
    'start:audio',
    'start:stt',
    'start:recovery',
    'stop:recovery',
    'stop:stt',
    'stop:audio',
    'stop:inference',
  ]);
});

test('RuntimeCoordinator rolls back already-started supervisors when startup fails', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {},
      async finalizeMeetingDeactivation() {},
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  coordinator.registerSupervisor({
    name: 'inference',
    async start() {
      calls.push('start:inference');
    },
    async stop() {
      calls.push('stop:inference');
    },
    getState() {
      return 'idle';
    },
  });

  coordinator.registerSupervisor({
    name: 'audio',
    async start() {
      calls.push('start:audio');
      throw new Error('audio start failed');
    },
    async stop() {
      calls.push('stop:audio');
    },
    getState() {
      return 'idle';
    },
  });

  coordinator.registerSupervisor({
    name: 'stt',
    async start() {
      calls.push('start:stt');
    },
    async stop() {
      calls.push('stop:stt');
    },
    getState() {
      return 'idle';
    },
  });

  coordinator.registerSupervisor({
    name: 'recovery',
    async start() {
      calls.push('start:recovery');
    },
    async stop() {
      calls.push('stop:recovery');
    },
    getState() {
      return 'idle';
    },
  });

  await assert.rejects(
    () => coordinator.startSupervisors(['inference', 'audio', 'stt', 'recovery']),
    /audio start failed/,
  );

  assert.deepEqual(calls, [
    'start:inference',
    'start:audio',
    'stop:inference',
  ]);
});

test('RuntimeCoordinator supports restarting an individual supervisor lane without a full meeting teardown', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {
        calls.push('delegate:start');
      },
      async finalizeMeetingDeactivation() {
        calls.push('delegate:stop');
      },
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: ['audio', 'stt'],
    },
  );

  for (const name of ['audio', 'stt'] as const) {
    coordinator.registerSupervisor({
      name,
      async start() {
        calls.push(`start:${name}`);
      },
      async stop() {
        calls.push(`stop:${name}`);
      },
      getState() {
        return 'idle';
      },
    });
  }

  await coordinator.activate({ source: 'test' });
  assert.equal(coordinator.getLifecycleState(), 'active');

  await coordinator.stopSupervisors(['stt']);
  await coordinator.startSupervisors(['stt']);
  assert.equal(coordinator.getLifecycleState(), 'active');

  await coordinator.deactivate();

  assert.deepEqual(calls, [
    'delegate:start',
    'start:audio',
    'start:stt',
    'stop:stt',
    'start:stt',
    'stop:stt',
    'stop:audio',
    'delegate:stop',
  ]);
});

test('RuntimeCoordinator ignores duplicate deactivate requests while stopping and still emits a single idle transition', async () => {
  const lifecycleEvents: string[] = [];
  let releaseStop: (() => void) | null = null;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const warnings: string[] = [];

  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {},
      async finalizeMeetingDeactivation() {},
    },
    {
      logger: {
        warn(message) {
          warnings.push(String(message));
        },
      },
      managedSupervisorNames: ['audio'],
    },
  );

  coordinator.registerSupervisor({
    name: 'audio',
    async start() {},
    async stop() {
      await stopGate;
    },
    getState() {
      return 'idle';
    },
  });

  coordinator.getBus().subscribeAll(async (event) => {
    lifecycleEvents.push(event.type);
  });

  await coordinator.activate();
  const firstDeactivate = coordinator.deactivate();
  const secondDeactivate = coordinator.deactivate();
  releaseStop?.();

  await Promise.all([firstDeactivate, secondDeactivate]);

  assert.equal(coordinator.getLifecycleState(), 'idle');
  assert.equal(lifecycleEvents.filter((event) => event === 'lifecycle:meeting-stopping').length, 1);
  assert.equal(lifecycleEvents.filter((event) => event === 'lifecycle:meeting-idle').length, 1);
  assert.ok(warnings.some((message) => message.includes('duplicate deactivate')));
});

test('RuntimeCoordinator still finalizes deactivation after supervisor shutdown fails and surfaces the error', async () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {},
      async finalizeMeetingDeactivation() {
        calls.push('delegate:stop');
      },
    },
    {
      logger: {
        warn(message) {
          warnings.push(String(message));
        },
      },
      managedSupervisorNames: ['audio'],
    },
  );

  coordinator.registerSupervisor({
    name: 'audio',
    async start() {},
    async stop() {
      calls.push('stop:audio');
      throw new Error('audio stop failed');
    },
    getState() {
      return 'idle';
    },
  });

  await coordinator.activate();
  await assert.rejects(() => coordinator.deactivate(), /audio stop failed/);

  assert.equal(coordinator.getLifecycleState(), 'idle');
  assert.deepEqual(calls, ['stop:audio', 'delegate:stop']);
  assert.ok(warnings.some((message) => message.includes('continuing to finalize deactivation')));
});

test('RuntimeCoordinator bus events include a stable meeting id for startup transitions', async () => {
  const events: Array<{ type: string; meetingId?: string }> = [];
  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {},
      async finalizeMeetingDeactivation() {},
    },
    {
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  coordinator.getBus().subscribeAll(async (event) => {
    events.push({ type: event.type, meetingId: 'meetingId' in event ? event.meetingId : undefined });
  });

  await coordinator.activate();
  await coordinator.deactivate();

  assert.equal(events[0]?.type, 'lifecycle:meeting-starting');
  assert.equal(events[1]?.type, 'lifecycle:meeting-active');
  assert.ok(events[0]?.meetingId);
  assert.equal(events[0]?.meetingId, events[1]?.meetingId);
  assert.equal(events[2]?.type, 'lifecycle:meeting-stopping');
  assert.equal(events[3]?.type, 'lifecycle:meeting-idle');
});
