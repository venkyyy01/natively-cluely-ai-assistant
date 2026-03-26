import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import {
  classifyConsciousModeQuestion,
  maybeHandleSuggestionTriggerFromTranscript,
  parseConsciousModeResponse,
  shouldAutoTriggerSuggestionFromTranscript,
  type ReasoningThread,
} from '../ConsciousMode';

type StreamCall = {
  message: string;
  context?: string;
  prompt?: string;
};

class FakeLLMHelper {
  public calls: StreamCall[] = [];

  async *streamChat(message: string, _imagePaths?: string[], context?: string, prompt?: string): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt });

    if (message.includes('ACTIVE_REASONING_THREAD')) {
      yield JSON.stringify({
        mode: 'reasoning_first',
        openingReasoning: 'I would keep the same partitioning strategy and stress where it bends.',
        implementationPlan: ['Keep the per-user token bucket', 'Add clearer backpressure controls'],
        tradeoffs: ['Higher coordination cost across regions'],
        edgeCases: ['Clock skew between nodes'],
        scaleConsiderations: ['Shard counters and move hot keys behind consistent hashing'],
        pushbackResponses: ['I chose this because it keeps the hot path simple while leaving room to shard later.'],
        likelyFollowUps: ['What if one shard gets hot?'],
        codeTransition: 'After that explanation, I would sketch the token bucket interface and storage abstraction.',
      });
      return;
    }

    if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
      yield JSON.stringify({
        mode: 'reasoning_first',
        openingReasoning: 'I would start by clarifying the rate limit dimension and the consistency target.',
        implementationPlan: ['Start with a per-user token bucket', 'Store counters in Redis', 'Add a small burst allowance'],
        tradeoffs: ['Redis adds operational overhead'],
        edgeCases: ['Users sharing an IP can create false positives'],
        scaleConsiderations: ['Shard keys and batch writes when traffic spikes'],
        pushbackResponses: ['I would say I optimized for predictable enforcement before global scale.'],
        likelyFollowUps: ['What happens if traffic is 10x larger?'],
        codeTransition: 'Once aligned on the approach, I would walk into the token refill logic.',
      });
      return;
    }

    yield 'plain answer';
  }
}

function addInterviewerTurn(session: SessionTracker, text: string, timestamp: number): void {
  session.handleTranscript({
    speaker: 'interviewer',
    text,
    timestamp,
    final: true,
  });
}

test('Conscious Mode routes qualifying technical questions into the structured reasoning contract', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now());

  const answer = await engine.runWhatShouldISay(undefined, 0.92);
  const structured = session.getLatestConsciousResponse();
  const thread = session.getActiveReasoningThread();

  assert.ok(answer);
  assert.ok(answer?.includes('Opening reasoning:'));
  assert.equal(structured?.mode, 'reasoning_first');
  assert.equal(structured?.openingReasoning, 'I would start by clarifying the rate limit dimension and the consistency target.');
  assert.deepEqual(structured?.implementationPlan, [
    'Start with a per-user token bucket',
    'Store counters in Redis',
    'Add a small burst allowance',
  ]);
  assert.equal(thread?.rootQuestion, 'How would you design a rate limiter for an API?');
  assert.equal(thread?.followUpCount, 0);
  assert.match(llmHelper.calls[0]?.message || '', /STRUCTURED_REASONING_RESPONSE/);
});

test('Conscious Mode qualifying follow-ups continue the thread, while a new technical topic resets it', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now() - 2000);
  await engine.runWhatShouldISay(undefined, 0.88);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'What are the tradeoffs?', Date.now() - 1000);
  await engine.runWhatShouldISay(undefined, 0.88);

  const continuedThread = session.getActiveReasoningThread();
  assert.equal(continuedThread?.rootQuestion, 'How would you design a rate limiter for an API?');
  assert.equal(continuedThread?.followUpCount, 1);
  assert.match(llmHelper.calls[1]?.message || '', /ACTIVE_REASONING_THREAD/);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'How would you migrate a monolith to microservices?', Date.now());
  await engine.runWhatShouldISay(undefined, 0.88);

  const resetThread = session.getActiveReasoningThread();
  assert.equal(resetThread?.rootQuestion, 'How would you migrate a monolith to microservices?');
  assert.equal(resetThread?.followUpCount, 0);
  assert.match(llmHelper.calls[2]?.message || '', /STRUCTURED_REASONING_RESPONSE/);
});

test('Conscious Mode does not spuriously route casual or admin transcript lines', () => {
  assert.deepEqual(classifyConsciousModeQuestion('I sent the calendar invite already', null), {
    qualifies: false,
    threadAction: 'ignore',
  });

  assert.deepEqual(classifyConsciousModeQuestion('Redis cache warmup is done', null), {
    qualifies: false,
    threadAction: 'ignore',
  });

  assert.deepEqual(classifyConsciousModeQuestion('okay sounds good', null), {
    qualifies: false,
    threadAction: 'ignore',
  });
});

test('Conscious Mode positively qualifies standalone pushback and scale phrases from the spec examples', () => {
  assert.deepEqual(classifyConsciousModeQuestion('Why this approach?', null), {
    qualifies: true,
    threadAction: 'start',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What are the tradeoffs?', null), {
    qualifies: true,
    threadAction: 'start',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What if this scales?', null), {
    qualifies: true,
    threadAction: 'start',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What if the input is 10x larger?', null), {
    qualifies: true,
    threadAction: 'start',
  });
});

test('Conscious Mode continuation and reset matrix handles explicit continue phrases and unrelated topics', () => {
  const thread = {
    rootQuestion: 'How would you design a rate limiter for an API?',
    lastQuestion: 'What are the tradeoffs?',
    followUpCount: 1,
    updatedAt: Date.now(),
    response: parseConsciousModeResponse(JSON.stringify({
      mode: 'reasoning_first',
      openingReasoning: 'Start with a token bucket.',
      implementationPlan: ['Use Redis'],
    })),
  };

  assert.deepEqual(classifyConsciousModeQuestion('Walk me through your thinking again', thread), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What are the tradeoffs?', thread), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What if traffic spikes 10x on this API?', thread), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('How would you shard this?', thread), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What happens during failover?', thread), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What if the input is 10x larger?', {
    ...thread,
    updatedAt: Date.now() - 120_000,
  }), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('How would you migrate a monolith to microservices?', thread), {
    qualifies: true,
    threadAction: 'reset',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What if?', thread), {
    qualifies: false,
    threadAction: 'ignore',
  });

  assert.deepEqual(classifyConsciousModeQuestion('Let us switch gears and talk about the launch plan.', thread), {
    qualifies: false,
    threadAction: 'reset',
  });
});

test('Conscious Mode response parser rejects malformed non-JSON thread payloads', () => {
  const malformed = parseConsciousModeResponse('here is a nice answer but not json at all');

  assert.equal(malformed.mode, 'invalid');
  assert.equal(malformed.openingReasoning, '');
  assert.deepEqual(malformed.implementationPlan, []);
});

test('Conscious Mode transcript auto-trigger widens only for qualifying short technical pushback phrases', () => {
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('Why this approach', false, null), false);
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('Why this approach', true, null), true);
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('What are the tradeoffs', true, null), true);
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('Can you repeat that for me', true, null), false);
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('okay sounds good', true, null), false);
});

test('Conscious Mode transcript-trigger path only fires handleSuggestionTrigger for qualifying interviewer prompts', async () => {
  const calls: Array<{ context: string; lastQuestion: string; confidence: number }> = [];
  const manager = {
    getActiveReasoningThread: (): ReasoningThread | null => null,
    getFormattedContext: (): string => 'ctx',
    handleSuggestionTrigger: async (trigger: { context: string; lastQuestion: string; confidence: number }) => {
      calls.push(trigger);
    },
  };

  await maybeHandleSuggestionTriggerFromTranscript({
    speaker: 'interviewer',
    text: 'Why this approach',
    final: true,
    confidence: 0.91,
    consciousModeEnabled: true,
    intelligenceManager: manager,
  });

  await maybeHandleSuggestionTriggerFromTranscript({
    speaker: 'interviewer',
    text: 'Can you repeat that for me',
    final: true,
    confidence: 0.72,
    consciousModeEnabled: true,
    intelligenceManager: manager,
  });

  assert.deepEqual(calls, [
    {
      context: 'ctx',
      lastQuestion: 'Why this approach',
      confidence: 0.91,
    },
  ]);
});

test('Non-Conscious transcript-trigger path preserves the existing actionable heuristic', async () => {
  const calls: Array<{ context: string; lastQuestion: string; confidence: number }> = [];
  const manager = {
    getActiveReasoningThread: (): ReasoningThread | null => null,
    getFormattedContext: (): string => 'ctx',
    handleSuggestionTrigger: async (trigger: { context: string; lastQuestion: string; confidence: number }) => {
      calls.push(trigger);
    },
  };

  await maybeHandleSuggestionTriggerFromTranscript({
    speaker: 'interviewer',
    text: 'Can you repeat that for me',
    final: true,
    confidence: 0.72,
    consciousModeEnabled: false,
    intelligenceManager: manager,
  });

  await maybeHandleSuggestionTriggerFromTranscript({
    speaker: 'interviewer',
    text: 'okay sounds good',
    final: true,
    confidence: 0.72,
    consciousModeEnabled: false,
    intelligenceManager: manager,
  });

  assert.deepEqual(calls, [
    {
      context: 'ctx',
      lastQuestion: 'Can you repeat that for me',
      confidence: 0.72,
    },
  ]);
});

test('Conscious Mode falls back to the normal intent path when structured output is malformed', async () => {
  class MalformedStructuredLLMHelper {
    public calls: string[] = [];

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

test('Conscious Mode reset clears the old thread before malformed structured fallback on a new technical topic', async () => {
  class ResetFallbackLLMHelper {
    public calls: string[] = [];

    async *streamChat(message: string): AsyncGenerator<string> {
      this.calls.push(message);

      if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
        if (message.includes('migrate a monolith to microservices')) {
          yield 'not-json-at-all';
          return;
        }

        yield JSON.stringify({
          mode: 'reasoning_first',
          openingReasoning: 'I would start by clarifying the rate limit dimension and the consistency target.',
          implementationPlan: ['Start with a per-user token bucket'],
          tradeoffs: ['Redis adds operational overhead'],
          edgeCases: [],
          scaleConsiderations: [],
          pushbackResponses: [],
          likelyFollowUps: [],
          codeTransition: '',
        });
        return;
      }

      yield 'Start with the strangler pattern and carve out one bounded context first.';
    }
  }

  const session = new SessionTracker();
  const llmHelper = new ResetFallbackLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now() - 1000);
  await engine.runWhatShouldISay(undefined, 0.9);

  const originalThread = session.getActiveReasoningThread();
  assert.equal(originalThread?.rootQuestion, 'How would you design a rate limiter for an API?');

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'How would you migrate a monolith to microservices?', Date.now());
  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'Start with the strangler pattern and carve out one bounded context first.');
  assert.equal(session.getActiveReasoningThread(), null);
  assert.equal(session.getLatestConsciousResponse(), null);
});
