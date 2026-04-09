import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeCoordinator } from '../runtime/RuntimeCoordinator';

test('RuntimeCoordinator activates and deactivates through the legacy delegate and emits lifecycle events', async () => {
  const delegateCalls: string[] = [];
  const lifecycleEvents: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async startMeetingLegacy() {
        delegateCalls.push('start');
      },
      async endMeetingLegacy() {
        delegateCalls.push('stop');
      },
    },
    {
      featureFlagReader: () => true,
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
      async startMeetingLegacy() {},
      async endMeetingLegacy() {},
    },
    {
      featureFlagReader: () => true,
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  await coordinator.activate();
  await assert.rejects(() => coordinator.activate(), /Cannot activate meeting while runtime is active/);
});

test('RuntimeCoordinator resets to idle when legacy activation fails', async () => {
  const lifecycleEvents: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async startMeetingLegacy() {
        throw new Error('activation failed');
      },
      async endMeetingLegacy() {},
    },
    {
      featureFlagReader: () => true,
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

test('RuntimeCoordinator exposes the feature gate state', () => {
  const disabledCoordinator = new RuntimeCoordinator(
    {
      async startMeetingLegacy() {},
      async endMeetingLegacy() {},
    },
    {
      featureFlagReader: () => false,
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  const enabledCoordinator = new RuntimeCoordinator(
    {
      async startMeetingLegacy() {},
      async endMeetingLegacy() {},
    },
    {
      featureFlagReader: () => true,
      logger: { warn() {} },
      managedSupervisorNames: [],
    },
  );

  assert.equal(disabledCoordinator.shouldManageLifecycle(), false);
  assert.equal(enabledCoordinator.shouldManageLifecycle(), true);
});

test('RuntimeCoordinator manages configured supervisors during activate/deactivate', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async startMeetingLegacy(_metadata, mode) {
        calls.push(`delegate:start:${mode}`);
      },
      async endMeetingLegacy(mode) {
        calls.push(`delegate:stop:${mode}`);
      },
    },
    {
      featureFlagReader: () => true,
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
    'delegate:start:coordinator',
    'start:recovery',
    'start:audio',
    'start:stt',
    'stop:stt',
    'stop:audio',
    'stop:recovery',
    'delegate:stop:coordinator',
  ]);
});

test('RuntimeCoordinator default lifecycle includes inference lane', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async startMeetingLegacy(_metadata, mode) {
        calls.push(`delegate:start:${mode}`);
      },
      async endMeetingLegacy(mode) {
        calls.push(`delegate:stop:${mode}`);
      },
    },
    {
      featureFlagReader: () => true,
      logger: { warn() {} },
    },
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
    'delegate:start:coordinator',
    'start:recovery',
    'start:audio',
    'start:stt',
    'start:inference',
    'stop:inference',
    'stop:stt',
    'stop:audio',
    'stop:recovery',
    'delegate:stop:coordinator',
  ]);
});

test('RuntimeCoordinator starts supervisors in order and stops them in reverse order', async () => {
  const calls: string[] = [];
  const coordinator = new RuntimeCoordinator(
    {
      async startMeetingLegacy() {},
      async endMeetingLegacy() {},
    },
    {
      featureFlagReader: () => true,
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
      async startMeetingLegacy() {},
      async endMeetingLegacy() {},
    },
    {
      featureFlagReader: () => true,
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
