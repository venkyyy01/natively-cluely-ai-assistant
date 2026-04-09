import test from 'node:test';
import assert from 'node:assert/strict';

import { SttSupervisor } from '../runtime/SttSupervisor';
import { SupervisorBus } from '../runtime/SupervisorBus';

test('SttSupervisor starts both lanes and emits transcript/provider-exhausted events', async () => {
  const calls: string[] = [];
  const events: string[] = [];
  const bus = new SupervisorBus({ error() {} });
  const supervisor = new SttSupervisor({
    bus,
    delegates: {
      async startSpeaker(speaker) {
        calls.push(`start:${speaker}`);
      },
      async stopSpeaker(speaker) {
        calls.push(`stop:${speaker}`);
      },
      async reconnectSpeaker(speaker) {
        calls.push(`reconnect:${speaker}`);
      },
    },
    logger: { warn() {} },
  });

  bus.subscribeAll(async (event) => {
    events.push(event.type);
  });

  await supervisor.start();
  await supervisor.handleTranscript('interviewer', 'hello', true);
  await supervisor.reportProviderExhausted('user');
  await supervisor.reconnectSpeaker('user');
  await supervisor.stop();

  assert.deepEqual(calls, [
    'start:interviewer',
    'start:user',
    'reconnect:user',
    'stop:interviewer',
    'stop:user',
  ]);
  assert.deepEqual(events, ['stt:transcript', 'stt:provider-exhausted']);
  assert.equal(supervisor.getState(), 'idle');
});

test('SttSupervisor marks the lane faulted when startSpeaker fails', async () => {
  const errors: string[] = [];
  const supervisor = new SttSupervisor({
    bus: new SupervisorBus({ error() {} }),
    delegates: {
      async startSpeaker(speaker) {
        if (speaker === 'interviewer') {
          throw new Error('stt failed');
        }
      },
      async stopSpeaker() {},
      async onError(_speaker, error) {
        errors.push(error.message);
      },
    },
    logger: { warn() {} },
  });

  await assert.rejects(() => supervisor.start(), /stt failed/);
  assert.equal(supervisor.getState(), 'faulted');
  assert.deepEqual(errors, ['stt failed']);
});

test('SttSupervisor ignores transcript emission only through the bus contract', async () => {
  const events: string[] = [];
  const bus = new SupervisorBus({ error() {} });
  const supervisor = new SttSupervisor({
    bus,
    delegates: {
      async startSpeaker() {},
      async stopSpeaker() {},
    },
  });

  bus.subscribeAll(async (event) => {
    events.push(event.type);
  });

  await supervisor.handleTranscript('user', 'question', false);
  await supervisor.handleTranscript('interviewer', 'answer', true);

  assert.deepEqual(events, ['stt:transcript', 'stt:transcript']);
});

test('SttSupervisor forwards recognition language updates through its delegate', async () => {
  const calls: string[] = [];
  const supervisor = new SttSupervisor({
    bus: new SupervisorBus({ error() {} }),
    delegates: {
      async startSpeaker() {},
      async stopSpeaker() {},
      async setRecognitionLanguage(language) {
        calls.push(language);
      },
    },
  });

  await supervisor.setRecognitionLanguage('en-US');

  assert.deepEqual(calls, ['en-US']);
});

test('SttSupervisor sheds non-essential work on stealth faults while running', async () => {
  const calls: string[] = [];
  const bus = new SupervisorBus({ error() {} });
  const supervisor = new SttSupervisor({
    bus,
    delegates: {
      async startSpeaker(speaker) {
        calls.push(`start:${speaker}`);
      },
      async stopSpeaker(speaker) {
        calls.push(`stop:${speaker}`);
      },
      async onStealthFault(reason) {
        calls.push(`stealth-fault:${reason}`);
      },
    },
  });

  await supervisor.start();
  await bus.emit({ type: 'stealth:fault', reason: 'stealth heartbeat missed' });

  assert.deepEqual(calls, ['start:interviewer', 'start:user', 'stealth-fault:stealth heartbeat missed']);
});

test('SttSupervisor ignores stealth faults while not running', async () => {
  const calls: string[] = [];
  const bus = new SupervisorBus({ error() {} });
  const supervisor = new SttSupervisor({
    bus,
    delegates: {
      async startSpeaker() {},
      async stopSpeaker() {},
      async onStealthFault(reason) {
        calls.push(`stealth-fault:${reason}`);
      },
    },
  });

  await bus.emit({ type: 'stealth:fault', reason: 'window_visible_to_capture' });
  assert.deepEqual(calls, []);

  await supervisor.start();
  await supervisor.stop();
  await bus.emit({ type: 'stealth:fault', reason: 'window_visible_to_capture' });
  assert.deepEqual(calls, []);
});
