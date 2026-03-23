import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';

class FakeLLMHelper {
  public messages: string[] = [];

  async *streamChat(message: string): AsyncGenerator<string> {
    this.messages.push(message);
    yield 'fast path answer';
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

  addTurn(session, 'interviewer', 'How would you design a rate limiter for an API?', Date.now() - 2000);
  session.addAssistantMessage('I would start with a token bucket in Redis.');

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'fast path answer');
  assert.equal(llmHelper.messages.length, 1);
  assert.doesNotMatch(llmHelper.messages[0], /DETECTED INTENT:/);
  assert.doesNotMatch(llmHelper.messages[0], /PREVIOUS RESPONSES/);

  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});
