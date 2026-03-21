import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { consciousModeRealtimeConfig } from '../consciousModeConfig';

function addInterviewerTurn(session: SessionTracker, text: string, timestamp: number): void {
  session.handleTranscript({
    speaker: 'interviewer',
    text,
    timestamp,
    final: true,
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise: promise as Promise<T>, resolve: resolve!, reject: reject! };
}

test('malformed Conscious output falls back without mutating thread memory', async () => {
  class MalformedStructuredLLMHelper {
    calls: string[] = [];

    async *streamChat(message: string): AsyncGenerator<string> {
      this.calls.push(message);

      if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
        yield 'not-json-at-all';
        return;
      }

      yield 'Start with a token bucket and keep the explanation simple.';
    }
  }

  const session = new SessionTracker();
  const llmHelper = new MalformedStructuredLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now());

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'Start with a token bucket and keep the explanation simple.');
  assert.equal(session.getLatestConsciousResponse(), null);
  assert.equal(session.getActiveReasoningThread(), null);
  assert.equal(llmHelper.calls.length, 2);
});

test('timeout/late Conscious result cannot overwrite fallback render', async () => {
  const config = consciousModeRealtimeConfig;

  const consciousDeferred = createDeferred<string>();

  class SlowConsciousLLMHelper {
    calls: string[] = [];

    async *streamChat(message: string): AsyncGenerator<string> {
      this.calls.push(message);

      if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
        void consciousDeferred.promise.then(async () => {
        });
        await new Promise<void>((resolve) => setTimeout(resolve, config.structuredGenerationTimeoutMs + 500));
        yield JSON.stringify({
          mode: 'reasoning_first',
          openingReasoning: 'I would start by clarifying the rate limit dimension.',
          implementationPlan: ['Start with a per-user token bucket'],
          tradeoffs: [],
          edgeCases: [],
          scaleConsiderations: [],
          pushbackResponses: [],
          likelyFollowUps: [],
          codeTransition: '',
        });
        return;
      }

      yield 'Start with a token bucket and keep the explanation simple.';
    }
  }

  const session = new SessionTracker();
  const llmHelper = new SlowConsciousLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now());

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'Start with a token bucket and keep the explanation simple.');

  assert.equal(session.getLatestConsciousResponse(), null);
  assert.equal(session.getActiveReasoningThread(), null);

  assert.equal(llmHelper.calls.length, 2);
});

test('fallback uses current turn and optional valid active summary only', async () => {
  let fallbackPrompt = '';

  class FallbackCaptureLLMHelper {
    calls: Array<{ message: string; context?: string }> = [];

    async *streamChat(message: string, _imagePaths?: string[], context?: string): AsyncGenerator<string> {
      this.calls.push({ message, context });

      if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
        yield JSON.stringify({
          mode: 'reasoning_first',
          openingReasoning: 'I would start by clarifying the rate limit dimension.',
          implementationPlan: ['Start with a per-user token bucket'],
          tradeoffs: [],
          edgeCases: [],
          scaleConsiderations: [],
          pushbackResponses: [],
          likelyFollowUps: [],
          codeTransition: '',
        });
        return;
      }

      fallbackPrompt = message;
      yield 'Start with a token bucket.';
    }
  }

  const session = new SessionTracker();
  const llmHelper = new FallbackCaptureLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now() - 5000);
  addInterviewerTurn(session, 'What about Redis?', Date.now());

  await engine.runWhatShouldISay(undefined, 0.9);

  assert.ok(fallbackPrompt.includes('What about Redis') || fallbackPrompt.includes('rate limiter'));
  assert.ok(!fallbackPrompt.includes('malformed') || !fallbackPrompt.includes('stale'));
});

test('repeated Conscious failures degrade to normal mode for the session', async () => {
  let callCount = 0;

  class AlwaysMalformedLLMHelper {
    async *streamChat(message: string): AsyncGenerator<string> {
      callCount++;

      if (message.includes('STRUCTURED_REASONING_RESPONSE') || message.includes('ACTIVE_REASONING_THREAD')) {
        yield 'malformed json';
        return;
      }

      yield 'Normal fallback answer.';
    }
  }

  const session = new SessionTracker();
  const llmHelper = new AlwaysMalformedLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter?', Date.now());

  const threshold = consciousModeRealtimeConfig.repeatedFailureThreshold;

  for (let i = 0; i < threshold; i++) {
    (engine as any).lastTriggerTime = 0;
    addInterviewerTurn(session, `Question ${i + 1}?`, Date.now() + i * 1000);
    await engine.runWhatShouldISay(undefined, 0.9);
  }

  assert.equal((session as any).consecutiveFailures, threshold);
  assert.equal((session as any).isDegraded, true);
});

test('degraded mode still produces answers', async () => {
  let callCount = 0;

  class AlwaysMalformedLLMHelper {
    async *streamChat(message: string): AsyncGenerator<string> {
      callCount++;

      if (message.includes('STRUCTURED_REASONING_RESPONSE') || message.includes('ACTIVE_REASONING_THREAD')) {
        yield 'malformed json';
        return;
      }

      yield 'Normal fallback answer that is helpful.';
    }
  }

  const session = new SessionTracker();
  const llmHelper = new AlwaysMalformedLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter?', Date.now());

  const threshold = consciousModeRealtimeConfig.repeatedFailureThreshold;

  for (let i = 0; i < threshold; i++) {
    (engine as any).lastTriggerTime = 0;
    addInterviewerTurn(session, `Question ${i + 1}?`, Date.now() + i * 1000);
    const answer = await engine.runWhatShouldISay(undefined, 0.9);
    assert.ok(answer);
  }

  assert.equal((session as any).isDegraded, true);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'Another question?', Date.now() + 10000);
  const answer = await engine.runWhatShouldISay(undefined, 0.9);
  assert.equal(answer, 'Normal fallback answer that is helpful.');
});

test('successful Conscious response after degradation clears degraded flag', async () => {
  let structuredCallCount = 0;

  class MixedLLMHelper {
    async *streamChat(message: string): AsyncGenerator<string> {
      if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
        structuredCallCount++;
        if (structuredCallCount <= 3) {
          yield 'malformed json';
          return;
        }
        yield JSON.stringify({
          mode: 'reasoning_first',
          openingReasoning: 'I would start by clarifying the rate limit dimension.',
          implementationPlan: ['Start with a per-user token bucket'],
          tradeoffs: [],
          edgeCases: [],
          scaleConsiderations: [],
          pushbackResponses: [],
          likelyFollowUps: [],
          codeTransition: '',
        });
        return;
      }

      yield 'Normal fallback answer.';
    }
  }

  const session = new SessionTracker();
  const llmHelper = new MixedLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter?', Date.now());

  const threshold = consciousModeRealtimeConfig.repeatedFailureThreshold;

  for (let i = 0; i < threshold; i++) {
    (engine as any).lastTriggerTime = 0;
    addInterviewerTurn(session, `Question ${i + 1}?`, Date.now() + i * 1000);
    await engine.runWhatShouldISay(undefined, 0.9);
  }

  assert.equal((session as any).isDegraded, true);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'Another technical question?', Date.now() + 10000);
  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.ok(answer?.includes('Opening reasoning:'));
  assert.equal((session as any).isDegraded, false);
});

test(' Conscious Mode timeout fires and falls back within bounded time', async () => {
  const config = consciousModeRealtimeConfig;

  class NeverCompletesLLMHelper {
    async *streamChat(_message: string): AsyncGenerator<string> {
      await new Promise<void>((resolve) => setTimeout(resolve, config.structuredGenerationTimeoutMs * 10));
      yield JSON.stringify({
        mode: 'reasoning_first',
        openingReasoning: 'Never used',
        implementationPlan: [],
        tradeoffs: [],
        edgeCases: [],
        scaleConsiderations: [],
        pushbackResponses: [],
        likelyFollowUps: [],
        codeTransition: '',
      });
    }
  }

  const session = new SessionTracker();
  const llmHelper = new NeverCompletesLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter?', Date.now());

  const start = Date.now();
  const answer = await engine.runWhatShouldISay(undefined, 0.9);
  const elapsed = Date.now() - start;

  assert.equal(answer, 'Could you repeat that? I want to make sure I address your question properly.');
  assert.ok(elapsed < config.structuredGenerationTimeoutMs * 5, `Timeout fallback took ${elapsed}ms, expected < ${config.structuredGenerationTimeoutMs * 5}ms`);
});

test('recordConsciousResponse handles reset and suspend actions', () => {
  const session = new SessionTracker();

  session.recordConsciousResponse(
    'How would you design a rate limiter?',
    {
      mode: 'reasoning_first',
      openingReasoning: 'Start with token bucket.',
      implementationPlan: ['Use Redis'],
      tradeoffs: [],
      edgeCases: [],
      scaleConsiderations: [],
      pushbackResponses: [],
      likelyFollowUps: [],
      codeTransition: '',
    },
    'reset'
  );

  assert.equal(session.getActiveReasoningThread(), null);
  assert.equal(session.getLatestConsciousResponse(), null);

  session.recordConsciousResponse(
    'How would you design a rate limiter?',
    {
      mode: 'reasoning_first',
      openingReasoning: 'Start with token bucket.',
      implementationPlan: ['Use Redis'],
      tradeoffs: [],
      edgeCases: [],
      scaleConsiderations: [],
      pushbackResponses: [],
      likelyFollowUps: [],
      codeTransition: '',
    },
    'suspend'
  );

  assert.equal(session.getActiveReasoningThread(), null);
  assert.equal(session.getSuspendedReasoningThread(), null);
});
