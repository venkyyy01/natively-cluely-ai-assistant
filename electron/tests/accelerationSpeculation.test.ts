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
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  accelerationManager.noteTranscriptText('interviewer', 'What is polymorphism?');
  accelerationManager.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );

  accelerationManager.onSilenceStart('What is polymorphism?');
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
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now() - 1000);
  accelerationManager.noteTranscriptText('interviewer', 'What is polymorphism?');
  accelerationManager.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  accelerationManager.onSilenceStart('What is polymorphism?');

  await new Promise((resolve) => setTimeout(resolve, 120));

  addTurn(session, 'interviewer', 'Explain encapsulation.', Date.now());
  accelerationManager.noteTranscriptText('interviewer', 'Explain encapsulation.');
  accelerationManager.updateTranscriptSegments(
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
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  accelerationManager.noteTranscriptText('interviewer', 'What is polymorphism?');
  accelerationManager.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  accelerationManager.onSilenceStart('What is polymorphism?');

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(await accelerationManager.getSpeculativeAnswer('What is polymorphism?', session.getTranscriptRevision(), 0), null);

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: What is polymorphism?');
  assert.equal(llmHelper.calls.length, 1);

  setActiveAccelerationManager(null);
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});
