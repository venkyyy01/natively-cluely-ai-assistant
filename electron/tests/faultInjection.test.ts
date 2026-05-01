import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { InferenceSupervisor } from '../runtime/InferenceSupervisor';
import { AudioSupervisor } from '../runtime/AudioSupervisor';
import { SttSupervisor } from '../runtime/SttSupervisor';
import { StealthSupervisor } from '../runtime/StealthSupervisor';
import { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';
import { WorkerPool } from '../runtime/WorkerPool';

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

test('fault injection: worker exhaustion keeps foreground lanes responsive while background remains lower priority', async () => {
  const scheduler = new RuntimeBudgetScheduler({
    workerPool: new WorkerPool({ size: 1 }),
    memoryUsageReader: () => 100 * 1024 * 1024,
  });

  const holdBackground = scheduler.submit('background', async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return 'background-hold';
  });
  const queuedBackground = scheduler.submit('background', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'background-queued';
  });
  const holdSemantic = scheduler.submit('semantic', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'semantic-hold';
  });
  const realtime = scheduler.submit('realtime', async () => 'realtime-ok');

  const queuedResult = await queuedBackground;
  assert.equal(await realtime, 'realtime-ok');
  assert.equal(await holdSemantic, 'semantic-hold');
  assert.equal(await holdBackground, 'background-hold');
  assert.equal(queuedResult, 'background-queued');
});

test('fault injection: memory pressure emits critical budget event', async () => {
  const bus = new SupervisorBus({ error() {} });
  const pressures: Array<{ lane: string; level: string }> = [];
  bus.subscribe('budget:pressure', async (event) => {
    pressures.push({ lane: event.lane, level: event.level });
  });

  const scheduler = new RuntimeBudgetScheduler({
    bus,
    workerPool: new WorkerPool({ size: 1 }),
    memoryUsageReader: () => 110 * 1024 * 1024,
  });

  await scheduler.submit('background', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'ok';
  });

  assert.ok(pressures.some((event) => event.level === 'critical'));
});

test('fault injection: stealth heartbeat loss is reported via proactive helper fault callback', async () => {
  const bus = new SupervisorBus({ error() {} });
  const faults: string[] = [];
  const calls: boolean[] = [];
  let helperFaultHandler: ((reason: string) => void | Promise<void>) | undefined;

  bus.subscribe('stealth:fault', async (event) => {
    faults.push(event.reason);
  });

  const stealth = new StealthSupervisor(
    {
      setEnabled: async (enabled) => {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      nativeBridge: {
        arm: async () => ({ connected: true, sessionId: 'fault-injection-heartbeat', surfaceId: 'surface-fault-injection-heartbeat' }),
        heartbeat: async () => ({ connected: true, healthy: true }),
        fault: async () => {},
        setHelperFaultHandler(handler: ((reason: string) => void | Promise<void>) | undefined) {
          helperFaultHandler = handler;
        },
      } as unknown as import('../stealth/NativeStealthBridge').NativeStealthBridge,
      heartbeatIntervalMs: 0,
    },
  );

  await stealth.start();
  await stealth.setEnabled(true);
  await helperFaultHandler?.('stealth-heartbeat-missed');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(faults, ['stealth-heartbeat-missed']);
  assert.deepEqual(calls, [true]);
});
