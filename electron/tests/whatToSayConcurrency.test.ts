import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';

class SequencedLLMHelper {
  public calls: Array<{ message: string; context?: string; prompt?: string }> = [];
  private callIndex = 0;

  async *streamChat(message: string, _imagePaths?: string[], context?: string, prompt?: string): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt });
    this.callIndex += 1;

    if (this.callIndex === 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield 'stale answer';
      return;
    }

    yield 'fresh answer';
  }
}

class AbortAwareLLMHelper {
  public enteredStream: Promise<void>;
  private readonly resolveEnteredStream: () => void;

  constructor() {
    let resolveEnteredStream!: () => void;
    this.enteredStream = new Promise<void>((resolve) => {
      resolveEnteredStream = resolve;
    });
    this.resolveEnteredStream = resolveEnteredStream;
  }

  async *streamChat(
    _message: string,
    _imagePaths?: string[],
    _context?: string,
    _prompt?: string,
    options?: { abortSignal?: AbortSignal }
  ): AsyncGenerator<string> {
    const signal = options?.abortSignal;
    await new Promise<void>((resolve) => {
      if (!signal) {
        this.resolveEnteredStream();
        return;
      }

      if (signal.aborted) {
        this.resolveEnteredStream();
        resolve();
        return;
      }

      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.resolveEnteredStream();
    });
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

class SlowStreamingLLMHelper {
  async *streamChat(_message: string, _imagePaths?: string[], _context?: string, _prompt?: string): AsyncGenerator<string> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    yield 'slow answer';
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
  const latencyTracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = latencyTracker;

  addTurn(session, 'interviewer', 'Old question?', Date.now() - 3000);
  session.addAssistantMessage('I would start with the constraints first.');
  session.handleTranscript({ speaker: 'interviewer', text: 'Latest interim question?', timestamp: Date.now() - 100, final: false });

  await engine.runWhatShouldISay(undefined, 0.9);
  const snapshot = latencyTracker.completedSnapshots[0];

  assert.equal(llmHelper.calls[0].message, 'Latest interim question?');
  assert.match(llmHelper.calls[0].context ?? '', /Latest interim question\?/);
  assert.doesNotMatch(llmHelper.calls[0].context ?? '', /Old question\?/);
  assert.equal(snapshot?.interimQuestionSubstitutionOccurred, true);
  assert.equal(snapshot?.marks.providerRequestStarted !== undefined, true);
  assert.equal(snapshot?.marks.enrichmentReady, undefined);
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

  const [firstAnswer, secondAnswer] = await Promise.all([first, second]);

  assert.equal(firstAnswer, null);
  assert.equal(secondAnswer, 'fresh answer');
  assert.deepEqual(finalAnswers, ['fresh answer']);
  assert.equal(session.getLastAssistantMessage(), 'fresh answer');

  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
});

test('explicit cancellation ends the active what-to-say request without emitting a fallback answer', async () => {
  const session = new SessionTracker();
  const llmHelper = new AbortAwareLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const finalAnswers: string[] = [];

  engine.on('suggested_answer', (answer: string) => {
    finalAnswers.push(answer);
  });

  addTurn(session, 'interviewer', 'Explain event sourcing.', Date.now());

  const cancelActiveWhatToSay = (engine as any).cancelActiveWhatToSay;
  assert.equal(typeof cancelActiveWhatToSay, 'function');

  const pending = engine.runWhatShouldISay(undefined, 0.9);
  await llmHelper.enteredStream;
  cancelActiveWhatToSay.call(engine, 'model_switched');

  const result = await Promise.race([
    pending,
    new Promise<symbol>((_, reject) => setTimeout(() => reject(new Error('what-to-say request did not cancel in time')), 100)),
  ]);

  assert.equal(result, null);
  assert.deepEqual(finalAnswers, []);
  assert.equal(session.getLastAssistantMessage(), null);
});

test('cooldown defers rapid follow-up instead of silently dropping when no active request exists', async () => {
  const session = new SessionTracker();
  const llmHelper = new SlowStreamingLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  (engine as any).triggerCooldown = 20;

  const answers: string[] = [];
  const metadataByAnswer: Array<{ cooldownSuppressedMs?: number }> = [];
  const deferredEvents: Array<{ suppressedMs: number; question?: string }> = [];

  engine.on('suggested_answer', (answer: string, _question: string, _confidence: number, metadata?: { cooldownSuppressedMs?: number }) => {
    answers.push(answer);
    metadataByAnswer.push({ cooldownSuppressedMs: metadata?.cooldownSuppressedMs });
  });
  engine.on('cooldown_deferred', (suppressedMs: number, question?: string) => {
    deferredEvents.push({ suppressedMs, question });
  });

  addTurn(session, 'interviewer', 'First question?', Date.now() - 200);
  const first = await engine.runWhatShouldISay(undefined, 0.9);
  assert.equal(first, 'slow answer');

  (engine as any).setMode('idle');
  addTurn(session, 'interviewer', 'Second question?', Date.now());
  const second = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(second, 'slow answer');
  assert.equal(answers.length, 2);
  assert.equal(session.getLastAssistantMessage(), 'slow answer');
  assert.equal(deferredEvents.length, 1);
  assert.equal(deferredEvents[0]!.suppressedMs > 0, true);
  assert.equal(deferredEvents[0]!.question, 'Second question?');
  assert.equal(metadataByAnswer[0]?.cooldownSuppressedMs, undefined);
  assert.equal((metadataByAnswer[1]?.cooldownSuppressedMs ?? 0) > 0, true);
});
