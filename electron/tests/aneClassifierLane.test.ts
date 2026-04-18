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
