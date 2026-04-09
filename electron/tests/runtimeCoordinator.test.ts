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
    },
  );

  assert.equal(disabledCoordinator.shouldManageLifecycle(), false);
  assert.equal(enabledCoordinator.shouldManageLifecycle(), true);
});

