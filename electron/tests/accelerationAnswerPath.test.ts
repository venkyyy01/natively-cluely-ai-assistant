import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';
import { FAST_STANDARD_ANSWER_PROMPT } from '../llm/prompts';

class FakeLLMHelper {
  public calls: Array<{ message: string; context?: string; prompt?: string }> = [];

  getProvider() {
    return 'openai';
  }

  async *streamChat(message: string, _imagePaths?: string[], context?: string, prompt?: string): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt });
    yield 'fast path answer';
  }
}

class CapturingLatencyTracker extends AnswerLatencyTracker {
  public completedSnapshots: Array<ReturnType<AnswerLatencyTracker['complete']>> = [];

  override complete(requestId: string) {
    const snapshot = super.complete(requestId);
    this.completedSnapshots.push(snapshot);
    return snapshot;
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

test('Acceleration Mode skips intent and temporal prompt augmentation for what-to-say answers', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
  });

  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const latencyTracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = latencyTracker;

  addTurn(session, 'interviewer', 'Tell me about your background.', Date.now() - 6000);
  session.addAssistantMessage('I have spent most of my career building backend systems.');
  addTurn(session, 'interviewer', 'What tradeoffs mattered on that project?', Date.now() - 4000);
  session.addAssistantMessage('Latency and operational simplicity mattered most.');
  addTurn(session, 'interviewer', 'How would you design a rate limiter for an API?', Date.now() - 2000);
  session.addAssistantMessage('I would start with a token bucket in Redis.');

  const answer = await engine.runWhatShouldISay(undefined, 0.9);
  const snapshot = latencyTracker.completedSnapshots[0];

  assert.equal(answer, 'fast path answer');
  assert.equal(llmHelper.calls.length, 1);
  assert.equal(llmHelper.calls[0].message, 'How would you design a rate limiter for an API?');
  assert.equal(llmHelper.calls[0].prompt, FAST_STANDARD_ANSWER_PROMPT);
  assert.match(llmHelper.calls[0].context ?? '', /How would you design a rate limiter for an API\?/);
  assert.match(llmHelper.calls[0].context ?? '', /I would start with a token bucket in Redis\./);
  assert.doesNotMatch(llmHelper.calls[0].context ?? '', /Tell me about your background\./);
  assert.doesNotMatch(llmHelper.calls[0].context ?? '', /DETECTED INTENT:/);
  assert.doesNotMatch(llmHelper.calls[0].context ?? '', /PREVIOUS RESPONSES/);
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.marks.providerRequestStarted !== undefined, true);
  assert.equal(snapshot?.marks.enrichmentReady, undefined);

  const adaptiveStats = session.getAdaptiveWindowStats();
  assert.ok(adaptiveStats.calls >= 0);

  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});
