import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioSupervisor } from '../runtime/AudioSupervisor';
import { SupervisorBus } from '../runtime/SupervisorBus';

test('AudioSupervisor forwards lifecycle events and delegates start/stop', async () => {
  const calls: string[] = [];
  const events: string[] = [];
  const bus = new SupervisorBus({ error() {} });
  const supervisor = new AudioSupervisor({
    bus,
    delegates: {
      async startCapture() {
        calls.push('start');
      },
      async stopCapture() {
        calls.push('stop');
      },
      async onChunk() {
        calls.push('chunk');
      },
      async onSpeechEnded() {
        calls.push('speech');
      },
    },
    logger: { warn() {} },
  });

  bus.subscribeAll(async (event) => {
    events.push(event.type);
  });

  await supervisor.start();
  await supervisor.handleChunk(Buffer.from([1, 2, 3]));
  await supervisor.handleSpeechEnded();
  await supervisor.reportGap(37);
  await supervisor.stop();

  assert.deepEqual(calls, ['start', 'chunk', 'speech', 'stop']);
  assert.deepEqual(events, ['audio:capture-started', 'audio:gap-detected', 'audio:capture-stopped']);
  assert.equal(supervisor.getState(), 'idle');
});

test('AudioSupervisor marks the lane faulted when startCapture fails', async () => {
  const errors: string[] = [];
  const supervisor = new AudioSupervisor({
    bus: new SupervisorBus({ error() {} }),
    delegates: {
      async startCapture() {
        throw new Error('audio failed');
      },
      async stopCapture() {},
      async onError(error) {
        errors.push(error.message);
      },
    },
    logger: { warn() {} },
  });

  await assert.rejects(() => supervisor.start(), /audio failed/);
  assert.equal(supervisor.getState(), 'faulted');
  assert.deepEqual(errors, ['audio failed']);
});

test('AudioSupervisor ignores chunk and speech callbacks when idle', async () => {
  const calls: string[] = [];
  const supervisor = new AudioSupervisor({
    bus: new SupervisorBus({ error() {} }),
    delegates: {
      async startCapture() {},
      async stopCapture() {},
      async onChunk() {
        calls.push('chunk');
      },
      async onSpeechEnded() {
        calls.push('speech');
      },
    },
  });

  await supervisor.handleChunk(Buffer.from([1]));
  await supervisor.handleSpeechEnded();

  assert.deepEqual(calls, []);
});

