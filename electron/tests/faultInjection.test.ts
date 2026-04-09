import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { InferenceSupervisor } from '../runtime/InferenceSupervisor';
import { AudioSupervisor } from '../runtime/AudioSupervisor';
import { SttSupervisor } from '../runtime/SttSupervisor';
import { StealthSupervisor } from '../runtime/StealthSupervisor';

test('fault injection: stealth heartbeat miss emits fail-closed fault and sheds critical lanes', async () => {
  const bus = new SupervisorBus({ error() {} });
  const calls: string[] = [];
  const faults: string[] = [];

  bus.subscribe('stealth:fault', async (event) => {
    faults.push(event.reason);
  });

  const inference = new InferenceSupervisor({
    bus,
    delegate: {
      start: async () => { calls.push('inference:start'); },
      stop: async () => { calls.push('inference:stop'); },
      onStealthFault: async (reason) => { calls.push(`inference:stealth-fault:${reason}`); },
      getLLMHelper: () => ({}) as unknown,
      runAssistMode: async () => null,
      runWhatShouldISay: async () => null,
      runFollowUp: async () => null,
      runRecap: async () => null,
      runFollowUpQuestions: async () => null,
      runManualAnswer: async () => null,
      getFormattedContext: () => '',
      getLastAssistantMessage: () => null,
      getActiveMode: () => 'idle',
      reset: async () => {},
      getRAGManager: () => null,
      getKnowledgeOrchestrator: () => null,
    },
  });

  const audio = new AudioSupervisor({
    bus,
    delegates: {
      startCapture: async () => { calls.push('audio:start'); },
      stopCapture: async () => { calls.push('audio:stop'); },
      onStealthFault: async (reason) => { calls.push(`audio:stealth-fault:${reason}`); },
    },
  });

  const stt = new SttSupervisor({
    bus,
    delegates: {
      startSpeaker: async () => { calls.push('stt:start'); },
      stopSpeaker: async () => { calls.push('stt:stop'); },
      onStealthFault: async (reason) => { calls.push(`stt:stealth-fault:${reason}`); },
    },
  });

  const stealth = new StealthSupervisor(
    {
      setEnabled: async () => {},
      isEnabled: () => false,
      verifyStealthState: () => true,
    },
    bus,
    {
      heartbeatIntervalMs: 1,
      intervalScheduler: () => ({ unref() {} }),
      clearIntervalScheduler: () => {},
    },
  );

  await inference.start();
  await audio.start();
  await stt.start();
  await stealth.start();
  await stealth.setEnabled(true).catch(() => {});

  // Inject explicit fail-closed fault for deterministic lane behavior.
  await stealth.reportFault(new Error('stealth heartbeat missed'));

  assert.deepEqual(faults, ['stealth heartbeat missed']);
  assert.ok(calls.includes('inference:stealth-fault:stealth heartbeat missed'));
  assert.ok(calls.includes('audio:stealth-fault:stealth heartbeat missed'));
  assert.ok(calls.includes('stt:stealth-fault:stealth heartbeat missed'));
});

test('fault injection: provider exhaustion emits stt:provider-exhausted event', async () => {
  const bus = new SupervisorBus({ error() {} });
  const events: string[] = [];

  bus.subscribe('stt:provider-exhausted', async (event) => {
    events.push(event.speaker);
  });

  const stt = new SttSupervisor({
    bus,
    delegates: {
      startSpeaker: async () => {},
      stopSpeaker: async () => {},
    },
  });

  await stt.reportProviderExhausted('interviewer');
  await stt.reportProviderExhausted('user');

  assert.deepEqual(events, ['interviewer', 'user']);
});
