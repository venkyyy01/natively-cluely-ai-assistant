import test from 'node:test';
import assert from 'node:assert/strict';

import { InterviewPhaseDetector } from '../conscious/InterviewPhase';
import { ConsciousAccelerationOrchestrator } from '../conscious/ConsciousAccelerationOrchestrator';
import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';

class StubClassifierLane implements Pick<RuntimeBudgetScheduler, 'submit'> {
  public readonly calls: string[] = [];

  async submit<T>(runtimeLane: 'realtime' | 'local-inference' | 'semantic' | 'background', task: () => Promise<T> | T): Promise<T> {
    this.calls.push(runtimeLane);
    return await task();
  }
}

test('InterviewPhaseDetector routes detection through semantic classifier lane when available', async () => {
  const lane = new StubClassifierLane();

  const detector = new InterviewPhaseDetector({ classifierLane: lane });
  const result = detector.detectPhase('How would this scale to a million users?', 'high_level_design', []);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.phase, 'scaling_discussion');
  assert.equal(lane.calls.length, 1);
  assert.equal(lane.calls[0], 'semantic');
});

test('ConsciousAccelerationOrchestrator routes pause-action classification through semantic lane', async () => {
  const lane = new StubClassifierLane();

  const orchestrator = new ConsciousAccelerationOrchestrator({
    classifierLane: lane,
    budgetScheduler: { shouldAdmitSpeculation: () => true },
  });
  orchestrator.setEnabled(true);
  orchestrator.getPauseDetector().updateConfig({
    minSilenceMs: 0,
    softSpeculateThreshold: 0,
    hardSpeculateThreshold: 0,
    commitThreshold: 0,
    evalIntervalMs: 1,
    maxEvaluationMs: 10,
  });
  orchestrator.onUserSpeaking('How would this architecture handle regional failover?');
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: 'How would this architecture handle regional failover?', timestamp: Date.now() },
  ], 1);
  orchestrator.onSilenceStart('How would this architecture handle regional failover?');

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(lane.calls.includes('semantic'));
});

test('ConsciousAccelerationOrchestrator preclassifies the latest transcript intent on silence and caches it by revision', async () => {
  const lane = new StubClassifierLane();
  let classifierCalls = 0;

  const orchestrator = new ConsciousAccelerationOrchestrator({
    classifierLane: lane,
    budgetScheduler: { shouldAdmitSpeculation: () => true },
    intentClassifier: async () => {
      classifierCalls += 1;
      return {
        intent: 'behavioral',
        confidence: 0.93,
        answerShape: 'Tell one grounded story.',
      };
    },
  });
  orchestrator.setEnabled(true);
  orchestrator.getPauseDetector().updateConfig({
    minSilenceMs: 0,
    softSpeculateThreshold: 0,
    hardSpeculateThreshold: 0,
    commitThreshold: 0,
    evalIntervalMs: 1,
    maxEvaluationMs: 10,
  });

  const question = 'Tell me about a time you had to influence a difficult stakeholder.';
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 7);
  orchestrator.onSilenceStart(question);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(classifierCalls, 1);
  assert.equal(orchestrator.getPrefetchedIntent(question, 7)?.intent, 'behavioral');
});

test('ConsciousAccelerationOrchestrator invalidates prefetched intents when transcript revision advances', async () => {
  const lane = new StubClassifierLane();

  const orchestrator = new ConsciousAccelerationOrchestrator({
    classifierLane: lane,
    budgetScheduler: { shouldAdmitSpeculation: () => true },
    intentClassifier: async () => ({
      intent: 'behavioral',
      confidence: 0.9,
      answerShape: 'Use one concrete example.',
    }),
  });
  orchestrator.setEnabled(true);
  orchestrator.getPauseDetector().updateConfig({
    minSilenceMs: 0,
    softSpeculateThreshold: 0,
    hardSpeculateThreshold: 0,
    commitThreshold: 0,
    evalIntervalMs: 1,
    maxEvaluationMs: 10,
  });

  const question = 'Tell me about a difficult stakeholder conversation.';
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 3);
  orchestrator.onSilenceStart(question);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(orchestrator.getPrefetchedIntent(question, 3)?.intent, 'behavioral');

  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 4);

  assert.equal(orchestrator.getPrefetchedIntent(question, 3), null);
  assert.equal(orchestrator.getPrefetchedIntent(question, 4), null);
});

test('ConsciousAccelerationOrchestrator does not start speculative answer work for weak or general prefetched intents', async () => {
  const lane = new StubClassifierLane();
  let speculativeCalls = 0;

  const orchestrator = new ConsciousAccelerationOrchestrator({
    classifierLane: lane,
    budgetScheduler: { shouldAdmitSpeculation: () => true },
    intentClassifier: async () => ({
      intent: 'general',
      confidence: 0.55,
      answerShape: 'Respond naturally.',
    }),
  });
  orchestrator.setEnabled(true);
  orchestrator.setSpeculativeExecutor(async function* () {
    speculativeCalls += 1;
    yield 'should not run';
  });
  orchestrator.getPauseDetector().updateConfig({
    minSilenceMs: 0,
    softSpeculateThreshold: 0,
    hardSpeculateThreshold: 0,
    commitThreshold: 0,
    evalIntervalMs: 1,
    maxEvaluationMs: 10,
  });

  const question = 'How would you answer this?';
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 9);
  orchestrator.onSilenceStart(question);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(speculativeCalls, 0);
});

test('ConsciousAccelerationOrchestrator starts speculative answer work for strong high-value prefetched intents', async () => {
  const lane = new StubClassifierLane();
  let speculativeCalls = 0;

  const orchestrator = new ConsciousAccelerationOrchestrator({
    classifierLane: lane,
    budgetScheduler: { shouldAdmitSpeculation: () => true },
    intentClassifier: async () => ({
      intent: 'coding',
      confidence: 0.93,
      answerShape: 'Provide a full implementation.',
    }),
  });
  orchestrator.setEnabled(true);
  orchestrator.setSpeculativeExecutor(async function* () {
    speculativeCalls += 1;
    yield 'speculation';
  });
  orchestrator.getPauseDetector().updateConfig({
    minSilenceMs: 0,
    softSpeculateThreshold: 0,
    hardSpeculateThreshold: 0,
    commitThreshold: 0,
    evalIntervalMs: 1,
    maxEvaluationMs: 10,
  });

  const question = 'Implement an idempotent webhook handler in TypeScript.';
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 11);
  orchestrator.onSilenceStart(question);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(speculativeCalls > 0);
});

test('ConsciousAccelerationOrchestrator deduplicates concurrent intent prefetches for the same query and revision', async () => {
  let classifierCalls = 0;
  let releaseClassifier: (() => void) | null = null;

  const orchestrator = new ConsciousAccelerationOrchestrator({
    budgetScheduler: { shouldAdmitSpeculation: () => true },
    intentClassifier: async () => {
      classifierCalls += 1;
      await new Promise<void>((resolve) => {
        releaseClassifier = resolve;
      });
      return {
        intent: 'behavioral',
        confidence: 0.94,
        answerShape: 'Tell one grounded story.',
      };
    },
  });
  orchestrator.setEnabled(true);

  const question = 'Tell me about a time you handled conflict.';
  orchestrator.noteTranscriptText('interviewer', question);
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 21);

  const first = (orchestrator as any).maybePrefetchIntent();
  const second = (orchestrator as any).maybePrefetchIntent();
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseClassifier?.();
  await Promise.all([first, second]);

  assert.equal(classifierCalls, 1);
  assert.equal(orchestrator.getPrefetchedIntent(question, 21)?.intent, 'behavioral');
});

test('ConsciousAccelerationOrchestrator suppresses stale speculative previews and finalized answers after revision changes', async () => {
  const orchestrator = new ConsciousAccelerationOrchestrator({
    budgetScheduler: { shouldAdmitSpeculation: () => true },
    intentClassifier: async () => ({
      intent: 'coding',
      confidence: 0.95,
      answerShape: 'Provide a full implementation.',
    }),
  });
  orchestrator.setEnabled(true);
  orchestrator.setSpeculativeExecutor(async function* () {
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield 'partial ';
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield 'response';
  });

  const question = 'Implement a retry-safe worker loop.';
  orchestrator.noteTranscriptText('interviewer', question);
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: question, timestamp: Date.now() },
  ], 12);
  await (orchestrator as any).maybePrefetchIntent();
  await (orchestrator as any).maybeStartSpeculativeAnswer();

  const previewPromise = orchestrator.getSpeculativeAnswerPreview(question, 12, 80);
  const key = (orchestrator as any).buildSpeculativeKey(question, 12);
  const finalizePromise = orchestrator.finalizeSpeculativeAnswer(key, 80);

  await new Promise((resolve) => setTimeout(resolve, 5));
  orchestrator.updateTranscriptSegments([
    { speaker: 'interviewer', text: `${question} with dead-letter handling`, timestamp: Date.now() },
  ], 13);

  assert.equal(await previewPromise, null);
  assert.equal(await finalizePromise, null);
});
