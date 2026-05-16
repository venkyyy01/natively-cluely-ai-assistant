import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioSupervisor } from '../runtime/AudioSupervisor';
import { RuntimeCoordinator } from '../runtime/RuntimeCoordinator';
import { SttSupervisor } from '../runtime/SttSupervisor';
import { SupervisorBus } from '../runtime/SupervisorBus';
import { WarmStandbyManager } from '../runtime/WarmStandbyManager';

test('RuntimeCoordinator reuses warm standby resources across rapid activation cycles', async () => {
  const calls: string[] = [];
  const warmStandby = new WarmStandbyManager({
    audio: {
      async warmUp() {
        calls.push('audio:warm');
        return { id: 'audio' };
      },
      checkHealth: () => true,
    },
    stt: {
      async warmUp() {
        calls.push('stt:warm');
        return { id: 'stt' };
      },
      checkHealth: () => true,
    },
    logger: { warn() {} },
  });

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
      managedSupervisorNames: [],
      warmStandbyManager: warmStandby,
      logger: { warn() {} },
    },
  );

  await coordinator.activate();
  await coordinator.deactivate();
  await coordinator.activate();
  await coordinator.deactivate();

  assert.deepEqual(calls, [
    'audio:warm',
    'stt:warm',
    'delegate:start',
    'delegate:stop',
    'delegate:start',
    'delegate:stop',
  ]);
  assert.equal(warmStandby.getState(), 'ready');
});

test('RuntimeCoordinator remains stable across 10 rapid warm activation cycles', async () => {
  let audioWarmups = 0;
  let sttWarmups = 0;
  let starts = 0;
  let stops = 0;

  const warmStandby = new WarmStandbyManager({
    audio: {
      async warmUp() {
        audioWarmups += 1;
        return { id: 'audio' };
      },
      checkHealth: () => true,
    },
    stt: {
      async warmUp() {
        sttWarmups += 1;
        return { id: 'stt' };
      },
      checkHealth: () => true,
    },
    logger: { warn() {} },
  });

  const coordinator = new RuntimeCoordinator(
    {
      async prepareMeetingActivation() {
        starts += 1;
      },
      async finalizeMeetingDeactivation() {
        stops += 1;
      },
    },
    {
      managedSupervisorNames: [],
      warmStandbyManager: warmStandby,
      logger: { warn() {} },
    },
  );

  for (let index = 0; index < 10; index += 1) {
    await coordinator.activate();
    await coordinator.deactivate();
  }

  assert.equal(audioWarmups, 1);
  assert.equal(sttWarmups, 1);
  assert.equal(starts, 10);
  assert.equal(stops, 10);
  assert.equal(warmStandby.getState(), 'ready');
});

test('AudioSupervisor and SttSupervisor prefer healthy warm standby resources', async () => {
  const calls: string[] = [];
  const warmStandby = new WarmStandbyManager({
    audio: {
      async warmUp() {
        return { id: 'audio' };
      },
      checkHealth: () => true,
    },
    stt: {
      async warmUp() {
        return { id: 'stt' };
      },
      checkHealth: () => true,
    },
    logger: { warn() {} },
  });
  await warmStandby.warmUp();

  const bus = new SupervisorBus({ error() {} });
  const audio = new AudioSupervisor({
    bus,
    warmStandby,
    delegates: {
      async startCapture() {
        calls.push('audio:cold');
      },
      async startCaptureFromWarmStandby() {
        calls.push('audio:warm');
      },
      async stopCapture() {},
    },
    logger: { warn() {} },
  });
  const stt = new SttSupervisor({
    bus,
    warmStandby,
    delegates: {
      async startSpeaker() {
        calls.push('stt:cold');
      },
      async startSpeakerFromWarmStandby(speaker) {
        calls.push(`stt:warm:${speaker}`);
      },
      async stopSpeaker() {},
    },
    logger: { warn() {} },
  });

  await audio.start();
  await stt.start();

  assert.deepEqual(calls, [
    'audio:warm',
    'stt:warm:interviewer',
    'stt:warm:user',
  ]);
});

test('AudioSupervisor falls back to cold capture after a simulated device-change invalidates warm standby', async () => {
  const calls: string[] = [];
  let healthy = true;
  const warmStandby = new WarmStandbyManager({
    audio: {
      async warmUp() {
        return { id: 'audio' };
      },
      async coolDown() {
        calls.push('audio:cool');
      },
      checkHealth: () => healthy,
    },
    logger: { warn() {} },
  });
  await warmStandby.warmUp();

  const audio = new AudioSupervisor({
    bus: new SupervisorBus({ error() {} }),
    warmStandby,
    delegates: {
      async startCapture() {
        calls.push('audio:cold');
      },
      async startCaptureFromWarmStandby() {
        calls.push('audio:warm');
      },
      async stopCapture() {},
    },
    logger: { warn() {} },
  });

  await audio.start();
  await audio.stop();

  healthy = false;
  await audio.start();

  assert.deepEqual(calls, [
    'audio:warm',
    'audio:cool',
    'audio:cold',
  ]);
});
