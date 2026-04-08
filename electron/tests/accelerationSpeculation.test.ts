import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { AccelerationManager, setActiveAccelerationManager } from '../services/AccelerationManager';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';

class DelayedFastLLMHelper {
  public calls: Array<{ message: string; context?: string; prompt?: string }> = [];

  async *streamChat(message: string, _imagePaths?: string[], context?: string, prompt?: string): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt });
    await new Promise((resolve) => setTimeout(resolve, 40));
    yield `speculative answer for: ${message}`;
  }
}

function addTurn(session: SessionTracker, speaker: 'interviewer' | 'assistant', text: string, timestamp: number): void {
  session.handleTranscript({
    speaker,
    text,
    timestamp,
    final: true,
  });
}

test('speculative fast answer is reused by the live what-to-say path', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const llmHelper = new DelayedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  accelerationManager.setConsciousModeEnabled(true);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );

  consciousAcceleration.onSilenceStart('What is polymorphism?');
  await new Promise((resolve) => setTimeout(resolve, 700));

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: What is polymorphism?');
  assert.equal(llmHelper.calls.length, 1);

  setActiveAccelerationManager(null);
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});

test('speculative answers are invalidated when transcript revision changes', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const llmHelper = new DelayedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  accelerationManager.setConsciousModeEnabled(true);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now() - 1000);
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  consciousAcceleration.onSilenceStart('What is polymorphism?');

  await new Promise((resolve) => setTimeout(resolve, 120));

  addTurn(session, 'interviewer', 'Explain encapsulation.', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'Explain encapsulation.');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: Explain encapsulation.');
  assert.equal(llmHelper.calls.length, 1);

  setActiveAccelerationManager(null);
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});

test('speculative acceleration stays disabled when conscious mode is off', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(false);
  const llmHelper = new DelayedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  accelerationManager.setConsciousModeEnabled(false);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  accelerationManager.getEnhancedCache().set(
    `answer:${session.getTranscriptRevision()}:fast:${'What is polymorphism?'.toLowerCase()}`,
    'cached answer that should be ignored'
  );
  consciousAcceleration.onSilenceStart('What is polymorphism?');

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(await consciousAcceleration.getSpeculativeAnswer('What is polymorphism?', session.getTranscriptRevision(), 0), null);

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: What is polymorphism?');
  assert.equal(llmHelper.calls.length, 1);

  setActiveAccelerationManager(null);
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});
