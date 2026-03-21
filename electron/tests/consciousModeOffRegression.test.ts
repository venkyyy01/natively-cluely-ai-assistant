import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';

class FakeLLMHelper {
  public messages: string[] = [];

  async *streamChat(message: string): AsyncGenerator<string> {
    this.messages.push(message);

    if (message.includes('STRUCTURED_REASONING_RESPONSE') || message.includes('ACTIVE_REASONING_THREAD')) {
      yield JSON.stringify({ openingReasoning: 'should not happen' });
      return;
    }

    yield 'Start with a simple token bucket backed by Redis.';
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

  addInterviewerTurn(session, 'How would you implement a rate limiter for an API?');

  const answer = await engine.runWhatShouldISay(undefined, 0.8);

  assert.equal(answer, 'Start with a simple token bucket backed by Redis.');
  assert.equal(session.getLastAssistantMessage(), 'Start with a simple token bucket backed by Redis.');
  assert.equal(session.getLatestConsciousResponse(), null);
  assert.equal(session.getActiveReasoningThread(), null);
  assert.ok(llmHelper.messages.every(message => !message.includes('STRUCTURED_REASONING_RESPONSE')));
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
