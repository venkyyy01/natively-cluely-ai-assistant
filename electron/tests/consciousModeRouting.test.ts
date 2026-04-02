import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import {
  classifyConsciousModeQuestion,
  formatConsciousModeResponse,
  getTranscriptSuggestionDecision,
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

function addUserTurn(session: SessionTracker, text: string, timestamp: number): void {
  session.handleTranscript({
    speaker: 'user',
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

test('Conscious Mode reasoning prompts include merged recent turns, prior assistant responses, and epoch summaries', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  session.addAssistantMessage('I would first pin down the burst policy before picking the storage layer.');
  (session as any).transcriptEpochSummaries = [
    'Earlier discussion: we aligned on Redis durability, failover, and a multi-region fallback.',
  ];

  addInterviewerTurn(session, 'How would you', Date.now() - 2000);
  addInterviewerTurn(session, 'design a rate limiter for an API?', Date.now() - 1500);

  await engine.runWhatShouldISay(undefined, 0.92);

  assert.match(llmHelper.calls[0]?.message || '', /QUESTION: How would you design a rate limiter for an API\?/);
  assert.match(llmHelper.calls[0]?.message || '', /PREVIOUS_RESPONSES: I would first pin down the burst policy before picking the storage layer\./);
  assert.match(llmHelper.calls[0]?.message || '', /SESSION_HISTORY:/);
  assert.match(llmHelper.calls[0]?.message || '', /Earlier discussion: we aligned on Redis durability, failover, and a multi-region fallback\./);
  assert.match(llmHelper.calls[0]?.message || '', /CONVERSATION:/);
  assert.match(llmHelper.calls[0]?.message || '', /\[INTERVIEWER\]: how would you design a rate limiter for an api\?/i);
});

test('Conscious Mode formats concise spoken responses by default while preserving hidden structured fields', () => {
  const response = parseConsciousModeResponse(JSON.stringify({
    mode: 'reasoning_first',
    questionType: 'approach',
    openingReasoning: 'My instinct would be to keep the write path simple first.',
    spokenResponse: 'I would start with a per-user token bucket in Redis, because it keeps enforcement predictable and is easy to explain. Then I would add a small burst window so normal spikes do not feel punitive.',
    implementationPlan: ['Start with a per-user token bucket', 'Store counters in Redis'],
    tradeoffs: ['Redis adds operational overhead'],
    likelyFollowUps: ['What happens if traffic is 10x larger?'],
  }));

  assert.equal(response.questionType, 'approach');
  assert.equal(response.spokenResponse, 'I would start with a per-user token bucket in Redis, because it keeps enforcement predictable and is easy to explain. Then I would add a small burst window so normal spikes do not feel punitive.');
  assert.deepEqual(response.implementationPlan, [
    'Start with a per-user token bucket',
    'Store counters in Redis',
  ]);
  assert.equal(
    formatConsciousModeResponse(response),
    'I would start with a per-user token bucket in Redis, because it keeps enforcement predictable and is easy to explain. Then I would add a small burst window so normal spikes do not feel punitive.',
  );
});

test('Conscious Mode still formats code-first concise payloads when spokenResponse is omitted', () => {
  const response = parseConsciousModeResponse(JSON.stringify({
    mode: 'reasoning_first',
    questionType: 'code',
    openingReasoning: 'I would keep the helper small and side-effect free.',
    codeBlock: {
      language: 'ts',
      code: 'const add = (a: number, b: number) => a + b;',
    },
  }));

  assert.equal(
    formatConsciousModeResponse(response),
    [
      'I would keep the helper small and side-effect free.',
      '```ts\nconst add = (a: number, b: number) => a + b;\n```',
    ].join('\n\n'),
  );
});

test('Conscious Mode emits the concise spoken response when the model returns the newer contract', async () => {
  class ConciseContractHelper {
    async *streamChat(message: string): AsyncGenerator<string> {
      if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
        yield JSON.stringify({
          mode: 'reasoning_first',
          questionType: 'approach',
          openingReasoning: 'My instinct would be to keep the write path simple first.',
          spokenResponse: 'I would start with a per-user token bucket in Redis, because it is easy to reason about and it keeps enforcement predictable. Then I would add a small burst allowance so normal spikes do not feel punitive.',
          tradeoffs: ['Redis adds operational overhead'],
          likelyFollowUps: ['What happens if traffic is 10x larger?'],
        });
        return;
      }

      yield 'plain answer';
    }
  }

  const session = new SessionTracker();
  const engine = new IntelligenceEngine(new ConciseContractHelper() as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now());

  const answer = await engine.runWhatShouldISay(undefined, 0.92);

  assert.equal(
    answer,
    'I would start with a per-user token bucket in Redis, because it is easy to reason about and it keeps enforcement predictable. Then I would add a small burst allowance so normal spikes do not feel punitive.',
  );
  assert.doesNotMatch(answer || '', /Opening reasoning:/);
  assert.equal(
    session.getLatestConsciousResponse()?.spokenResponse,
    'I would start with a per-user token bucket in Redis, because it is easy to reason about and it keeps enforcement predictable. Then I would add a small burst allowance so normal spikes do not feel punitive.',
  );
});

test('Conscious Mode keeps the latest overlap group in the reasoning prompt when the interviewer interrupts mid-answer near the context window boundary', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const originalNow = Date.now;

  Date.now = () => 200_000;

  try {
    session.setConsciousModeEnabled(true);
    addInterviewerTurn(session, 'Walk me through the design.', 19_400);
    addUserTurn(session, 'I would start with the API boundary.', 19_700);
    addInterviewerTurn(session, 'What happens if traffic spikes?', 20_200);

    await engine.runWhatShouldISay(undefined, 0.92);

    assert.match(llmHelper.calls[0]?.message || '', /\[ME\]: i would start with the api boundary\./i);
    assert.match(llmHelper.calls[0]?.message || '', /\[INTERVIEWER\]: what happens if traffic spikes\?/i);
  } finally {
    Date.now = originalNow;
  }
});

test('Conscious Mode keeps long-session prompts bounded while preserving bidirectional recent context and earlier summaries', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const originalNow = Date.now;

  Date.now = () => 400_000;

  try {
    session.setConsciousModeEnabled(true);
    (session as any).transcriptEpochSummaries = [
      'Earlier discussion: we already aligned on Redis durability, failover, and the need to keep the write path simple.',
    ];

    for (let index = 0; index < 18; index += 1) {
      const timestamp = 250_000 + (index * 5_000);
      if (index % 2 === 0) {
        addInterviewerTurn(session, `Interviewer turn ${index}: how would this design behave under load?`, timestamp);
      } else {
        addUserTurn(session, `User turn ${index}: I would isolate the write path before optimizing reads.`, timestamp);
      }
    }

    await engine.runWhatShouldISay('How would you design a rate limiter for an API?', 0.92);

    const message = llmHelper.calls[0]?.message || '';
    const conversationSection = message.split('CONVERSATION:\n')[1] || '';
    const conversationLines = conversationSection.split('\n').filter((line) => /^\[(INTERVIEWER|ME)\]:/i.test(line));

    assert.match(message, /SESSION_HISTORY:/);
    assert.match(message, /Earlier discussion: we already aligned on Redis durability, failover, and the need to keep the write path simple\./);
    assert.ok(conversationLines.length <= 12);
    assert.ok(conversationLines.some((line) => /\[INTERVIEWER\]:/i.test(line)));
    assert.ok(conversationLines.some((line) => /\[ME\]:/i.test(line)));
    assert.doesNotMatch(message, /Interviewer turn 0:/);
  } finally {
    Date.now = originalNow;
  }
});

test('Conscious Mode continuation prompts keep prior assistant responses alongside the active thread context', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now() - 2000);
  await engine.runWhatShouldISay(undefined, 0.88);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'What are the tradeoffs?', Date.now() - 1000);
  await engine.runWhatShouldISay(undefined, 0.88);

  assert.match(llmHelper.calls[1]?.message || '', /ACTIVE_REASONING_THREAD/);
  assert.match(llmHelper.calls[1]?.message || '', /PREVIOUS_RESPONSES:/);
  assert.match(llmHelper.calls[1]?.message || '', /Opening reasoning: I would start by clarifying the rate limit dimension and the consistency target\./);
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

test('Conscious Mode keeps continuation phrases on the normal path when no active thread exists', () => {
  assert.deepEqual(classifyConsciousModeQuestion('What are the tradeoffs?', null), {
    qualifies: true,
    threadAction: 'start',
  });

  assert.deepEqual(classifyConsciousModeQuestion('How would you shard this?', null), {
    qualifies: true,
    threadAction: 'start',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What happens during failover?', null), {
    qualifies: false,
    threadAction: 'ignore',
  });
});

test('Conscious Mode only starts for system-design questions and prefers fresh starts for ambiguous new design prompts', () => {
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

  assert.deepEqual(classifyConsciousModeQuestion('How would you design a notification system?', null), {
    qualifies: true,
    threadAction: 'start',
  });

  assert.deepEqual(classifyConsciousModeQuestion('Write the debounce function in TypeScript.', null), {
    qualifies: false,
    threadAction: 'ignore',
  });

  assert.deepEqual(classifyConsciousModeQuestion('How would you design the data model for billing?', thread), {
    qualifies: true,
    threadAction: 'reset',
  });
});

test('Conscious Mode continuation and reset matrix handles deterministic continuation phrases and unrelated topics', () => {
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

  assert.deepEqual(classifyConsciousModeQuestion('What are the tradeoffs?', thread), {
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

  assert.deepEqual(classifyConsciousModeQuestion('What metrics would you watch first?', thread), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What if traffic spikes 10x on this API?', thread), {
    qualifies: true,
    threadAction: 'continue',
  });

  assert.deepEqual(classifyConsciousModeQuestion('How would you design a payment ledger?', {
    ...thread,
    updatedAt: Date.now() - 120000,
  }), {
    qualifies: true,
    threadAction: 'reset',
  });

  assert.deepEqual(classifyConsciousModeQuestion('How would you design a cache invalidation service?', thread), {
    qualifies: true,
    threadAction: 'reset',
  });

  assert.deepEqual(classifyConsciousModeQuestion('What if?', thread), {
    qualifies: false,
    threadAction: 'ignore',
  });

  assert.deepEqual(classifyConsciousModeQuestion('Let us switch gears and talk about the launch plan.', thread), {
    qualifies: true,
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
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('Why this approach', true, null), false);
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('What are the tradeoffs', true, null), true);
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('Can you repeat that for me', true, null), false);
  assert.equal(shouldAutoTriggerSuggestionFromTranscript('okay sounds good', true, null), false);
});

test('Conscious Mode prioritizes interviewer-question triggers over lower-priority conversation-state triggers', () => {
  const decision = getTranscriptSuggestionDecision(
    'What are the tradeoffs',
    true,
    null,
    {
      speaker: 'interviewer',
      enableConversationStateTrigger: true,
    },
  );

  assert.equal(decision.shouldTrigger, true);
  assert.equal(decision.triggerType, 'interviewer_question');
  assert.deepEqual(decision.suppressedTriggerTypes, ['conversation_state']);
});

test('Conscious Mode keeps conversation-state triggers disabled by default for user turns', () => {
  const decision = getTranscriptSuggestionDecision(
    'I would start with the API boundary and the write path.',
    true,
    null,
    {
      speaker: 'user',
      enableConversationStateTrigger: false,
    },
  );

  assert.deepEqual(decision, {
    shouldTrigger: false,
    lastQuestion: 'I would start with the API boundary and the write path.',
    triggerType: null,
    suppressedTriggerTypes: [],
  });
});

test('Conscious Mode transcript-trigger path fires for substantive interviewer prompts when awareness is enabled', async () => {
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
    text: 'What are the tradeoffs',
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
      lastQuestion: 'What are the tradeoffs',
      confidence: 0.91,
    },
  ]);
});

test('Conscious Mode conversation-state trigger negative corpus keeps false positives at zero for admin and filler turns', () => {
  const negatives = [
    'sounds good',
    'okay we can move on',
    'I already sent the calendar invite',
    'thanks that helps',
    'cool got it',
    'let me know when you are ready',
    'yes that makes sense',
    'done already',
  ];

  const falsePositives = negatives.filter((text) => {
    const decision = getTranscriptSuggestionDecision(text, true, null, {
      speaker: 'user',
      enableConversationStateTrigger: true,
    });

    return decision.triggerType === 'conversation_state';
  });

  assert.deepEqual(falsePositives, []);
});

test('Conscious Mode conversation-state trigger can fire for substantive user turns only when explicitly enabled', async () => {
  const calls: Array<{ context: string; lastQuestion: string; confidence: number }> = [];
  const manager = {
    getActiveReasoningThread: (): ReasoningThread | null => null,
    getFormattedContext: (): string => 'ctx',
    handleSuggestionTrigger: async (trigger: { context: string; lastQuestion: string; confidence: number }) => {
      calls.push(trigger);
    },
  };

  await maybeHandleSuggestionTriggerFromTranscript({
    speaker: 'user',
    text: 'I would start with the API boundary and then separate reads from writes.',
    final: true,
    confidence: 0.87,
    consciousModeEnabled: true,
    enableConversationStateTrigger: true,
    intelligenceManager: manager,
  });

  assert.deepEqual(calls, [
    {
      context: 'ctx',
      lastQuestion: 'I would start with the API boundary and then separate reads from writes.',
      confidence: 0.87,
    },
  ]);
});

test('Conscious Mode routes screenshot-backed live-coding turns but keeps the same question on the fast path without screenshots', async () => {
  class LiveCodingHelper {
    public calls: Array<{ message: string; prompt?: string }> = [];

    async *streamChat(message: string, _imagePaths?: string[], _context?: string, prompt?: string): AsyncGenerator<string> {
      this.calls.push({ message, prompt });

      if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
        yield JSON.stringify({
          mode: 'reasoning_first',
          openingReasoning: 'I would read the failing state from the screenshot first, then patch the debounce flow.',
          implementationPlan: ['Confirm stale closure path', 'Patch the debounce state update'],
          tradeoffs: [],
          edgeCases: [],
          scaleConsiderations: [],
          pushbackResponses: [],
          likelyFollowUps: [],
          codeTransition: '',
        });
        return;
      }

      yield 'Use a debounced callback and clear the previous timeout before scheduling a new one.';
    }
  }

  const question = 'Write the debounce function in TypeScript.';

  const noScreenshotSession = new SessionTracker();
  const noScreenshotHelper = new LiveCodingHelper();
  const noScreenshotEngine = new IntelligenceEngine(noScreenshotHelper as any, noScreenshotSession);
  noScreenshotSession.setConsciousModeEnabled(true);
  addInterviewerTurn(noScreenshotSession, question, Date.now() - 1000);

  const fastAnswer = await noScreenshotEngine.runWhatShouldISay(undefined, 0.9);
  assert.equal(fastAnswer, 'Use a debounced callback and clear the previous timeout before scheduling a new one.');
  assert.equal(noScreenshotSession.getLatestConsciousResponse(), null);
  assert.ok(noScreenshotHelper.calls.every(call => !call.message.includes('STRUCTURED_REASONING_RESPONSE')));

  const screenshotSession = new SessionTracker();
  const screenshotHelper = new LiveCodingHelper();
  const screenshotEngine = new IntelligenceEngine(screenshotHelper as any, screenshotSession);
  screenshotSession.setConsciousModeEnabled(true);
  addInterviewerTurn(screenshotSession, question, Date.now());

  const consciousAnswer = await screenshotEngine.runWhatShouldISay(undefined, 0.9, ['/tmp/editor.png']);
  assert.match(consciousAnswer || '', /Opening reasoning:/);
  assert.equal(screenshotSession.getLatestConsciousResponse()?.mode, 'reasoning_first');
  assert.match(screenshotHelper.calls[0]?.message || '', /STRUCTURED_REASONING_RESPONSE/);
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

test('Conscious Mode preserves interviewer-only behavior when conversation-state triggering is not enabled', async () => {
  const calls: Array<{ context: string; lastQuestion: string; confidence: number }> = [];
  const manager = {
    getActiveReasoningThread: (): ReasoningThread | null => null,
    getFormattedContext: (): string => 'ctx',
    handleSuggestionTrigger: async (trigger: { context: string; lastQuestion: string; confidence: number }) => {
      calls.push(trigger);
    },
  };

  await maybeHandleSuggestionTriggerFromTranscript({
    speaker: 'user',
    text: 'I would start with the API boundary and then separate reads from writes.',
    final: true,
    confidence: 0.87,
    consciousModeEnabled: true,
    intelligenceManager: manager,
  });

  assert.deepEqual(calls, []);
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
