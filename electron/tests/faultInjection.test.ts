import test from 'node:test';
import assert from 'node:assert/strict';

import { SupervisorBus } from '../runtime/SupervisorBus';
import { InferenceSupervisor } from '../runtime/InferenceSupervisor';
import { AudioSupervisor } from '../runtime/AudioSupervisor';
import { SttSupervisor } from '../runtime/SttSupervisor';
import { StealthSupervisor } from '../runtime/StealthSupervisor';
import { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';
import { WorkerPool } from '../runtime/WorkerPool';
import { ConsciousAccelerationOrchestrator } from '../conscious/ConsciousAccelerationOrchestrator';
import { DropFrameMetric } from '../audio/dropMetrics';

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

test('NAT-084: speculative invalidation between preview and finalize yields no suggested_answer', async () => {
  const orchestrator = new ConsciousAccelerationOrchestrator({
    budgetScheduler: { shouldAdmitSpeculation: () => true },
    intentClassifier: async () => ({
      intent: 'coding',
      confidence: 0.95,
      answerShape: 'Provide a full implementation.',
    }),
  });
  orchestrator.setEnabled(true);

  let generatorAborted = false;
  orchestrator.setSpeculativeExecutor(async function* (_query, _revision, abortSignal) {
    abortSignal.addEventListener('abort', () => { generatorAborted = true; }, { once: true });
    yield 'partial ';
    await new Promise<void>((resolve) => {
      abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
  });

  const question = 'Implement a retry-safe worker loop.';
  orchestrator.noteTranscriptText('interviewer', question);
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 42);
  await (orchestrator as any).maybePrefetchIntent();
  await (orchestrator as any).maybeStartSpeculativeAnswer();

  // Retrieve preview to establish the entry
  await orchestrator.getSpeculativeAnswerPreview(question, 42, 50);

  // Invalidate speculation before finalize by changing transcript revision
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: 'new question', timestamp: Date.now() },
  ], 99);

  const key = (orchestrator as any).buildSpeculativeKey(question, 42);
  const result = await orchestrator.finalizeSpeculativeAnswer(key, 600);

  // After invalidation, finalize should return null (abandoned), never the partial text
  assert.equal(result, null, 'finalize after invalidation must return null, never a suggested_answer');
  assert.equal(generatorAborted, true, 'generator should be aborted');
});

test('NAT-084: STT frame drops surface as cumulative metrics', () => {
  const metric = new DropFrameMetric({
    provider: 'deepgram',
    flushIntervalMs: 60_000,
    logger: { warn() {} },
  });

  metric.recordDrop(3);
  metric.recordDrop(7);

  let counters = metric.getCounters();
  assert.equal(counters.windowDropped, 10);
  assert.equal(counters.cumulativeDropped, 10);

  metric.recordDrop(5);
  counters = metric.getCounters();
  assert.equal(counters.cumulativeDropped, 15);

  metric.stop(false);
});

test('NAT-084: helper crash mid-stream recovers via fresh spawn', async () => {
  // Simulate a helper-host pattern: first spawn crashes mid-stream,
  // second spawn succeeds. The consumer must receive the successful result.
  let spawnCount = 0;

  const mockHelperHost = {
    async *send(request: string): AsyncGenerator<string> {
      spawnCount += 1;
      if (spawnCount === 1) {
        yield 'partial';
        throw new Error('helper crash');
      }
      yield `success for: ${request}`;
    },
  };

  async function resilientStream(request: string): Promise<string> {
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const chunks: string[] = [];
        for await (const chunk of mockHelperHost.send(request)) {
          chunks.push(chunk);
        }
        return chunks.join('');
      } catch (err: any) {
        if (attempt >= maxRetries) throw err;
        // Simulate restart delay
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    throw new Error('unreachable');
  }

  const result = await resilientStream('test-request');
  assert.equal(result, 'success for: test-request');
  assert.equal(spawnCount, 2, 'helper should be respawned once after crash');
});
