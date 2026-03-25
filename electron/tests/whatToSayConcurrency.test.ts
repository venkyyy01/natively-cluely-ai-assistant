import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';

class SequencedLLMHelper {
  public messages: string[] = [];
  private callIndex = 0;

  async *streamChat(message: string): AsyncGenerator<string> {
    this.messages.push(message);
    this.callIndex += 1;

    if (this.callIndex === 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield 'stale answer';
      return;
    }

    yield 'fresh answer';
  }
}

function addTurn(session: SessionTracker, speaker: 'interviewer' | 'assistant', text: string, timestamp: number): void {
  session.handleTranscript({ speaker, text, timestamp, final: true });
}

test('fast path uses the latest interim interviewer transcript in the generated prompt', async () => {
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS, accelerationEnabled: true, useParallelContext: true });

  const session = new SessionTracker();
  const llmHelper = new SequencedLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  addTurn(session, 'interviewer', 'Old question?', Date.now() - 3000);
  session.handleTranscript({ speaker: 'interviewer', text: 'Latest interim question?', timestamp: Date.now() - 100, final: false });

  await engine.runWhatShouldISay(undefined, 0.9);

  assert.match(llmHelper.messages[0], /Latest interim question\?/);
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});

test('older overlapping what-to-say requests do not overwrite the newest answer', async () => {
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS, accelerationEnabled: true, useParallelContext: true });

  const session = new SessionTracker();
  const llmHelper = new SequencedLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const finalAnswers: string[] = [];

  engine.on('suggested_answer', (answer: string) => {
    finalAnswers.push(answer);
  });

  addTurn(session, 'interviewer', 'First question?', Date.now() - 1000);
  const first = engine.runWhatShouldISay(undefined, 0.8);

  await new Promise((resolve) => setTimeout(resolve, 5));
  addTurn(session, 'interviewer', 'Second question?', Date.now());
  const second = engine.runWhatShouldISay(undefined, 0.95);

  const [, secondAnswer] = await Promise.all([first, second]);

  assert.equal(secondAnswer, 'fresh answer');
  assert.deepEqual(finalAnswers, ['fresh answer']);
  assert.equal(session.getLastAssistantMessage(), 'fresh answer');

  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});
