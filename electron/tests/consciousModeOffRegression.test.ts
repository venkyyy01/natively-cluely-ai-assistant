import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';

class FakeLLMHelper {
  public calls: Array<{ message: string; context?: string; prompt?: string }> = [];

  async *streamChat(message: string, _imagePaths?: string[], context?: string, prompt?: string): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt });

    if (message.includes('STRUCTURED_REASONING_RESPONSE') || message.includes('ACTIVE_REASONING_THREAD')) {
      yield JSON.stringify({ openingReasoning: 'should not happen' });
      return;
    }

    yield 'Start with a simple token bucket backed by Redis.';
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

function addInterviewerTurn(session: SessionTracker, text: string): void {
  session.handleTranscript({
    speaker: 'interviewer',
    text,
    timestamp: Date.now(),
    final: true,
  });
}

test('Conscious Mode off keeps the existing answer path unchanged for technical questions', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const latencyTracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = latencyTracker;

  addInterviewerTurn(session, 'Can you summarize your background first?');
  session.addAssistantMessage('I have spent the last five years on distributed systems.');
  addInterviewerTurn(session, 'How would you implement a rate limiter for an API?');

  const answer = await engine.runWhatShouldISay(undefined, 0.8);
  const snapshot = latencyTracker.completedSnapshots[0];

  assert.equal(answer, 'Start with a simple token bucket backed by Redis.');
  assert.equal(session.getLastAssistantMessage(), 'Start with a simple token bucket backed by Redis.');
  assert.equal(session.getLatestConsciousResponse(), null);
  assert.equal(session.getActiveReasoningThread(), null);
  assert.ok(llmHelper.calls.every(call => !call.message.includes('STRUCTURED_REASONING_RESPONSE')));
  assert.equal(llmHelper.calls[0].message, 'How would you implement a rate limiter for an API?');
  assert.doesNotMatch(llmHelper.calls[0].context ?? '', /Can you summarize your background first\?/);
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.marks.providerRequestStarted !== undefined, true);
  assert.equal(snapshot?.marks.enrichmentReady, undefined);
});

test('Conscious Mode off leaves follow-up refinement behavior unchanged', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.addAssistantMessage('Start with a simple token bucket backed by Redis and add burst handling.');

  const refined = await engine.runFollowUp('shorten', 'Make it shorter');

  assert.equal(refined, 'Start with a simple token bucket backed by Redis.');
  assert.equal(session.getLatestConsciousResponse(), null);
  assert.equal(session.getActiveReasoningThread(), null);
});

test('SessionTracker reset preserves Conscious Mode toggle while clearing transient Conscious Mode state', () => {
  const session = new SessionTracker();

  session.setConsciousModeEnabled(true);
  session.recordConsciousResponse('How would you design a cache?', {
    mode: 'reasoning_first',
    openingReasoning: 'Start by clarifying read and write patterns.',
    implementationPlan: ['Pick cache-aside'],
    tradeoffs: [],
    edgeCases: [],
    scaleConsiderations: [],
    pushbackResponses: [],
    likelyFollowUps: [],
    codeTransition: '',
  }, 'start');

  session.reset();

  assert.equal(session.isConsciousModeEnabled(), true);
  assert.equal(session.getLatestConsciousResponse(), null);
  assert.equal(session.getActiveReasoningThread(), null);
});
