const test = require('node:test');
const assert = require('node:assert/strict');
const { IntelligenceEngine } = require('../IntelligenceEngine');
const { SessionTracker } = require('../SessionTracker');
const {
  createEmptyConsciousModeResponse,
  formatConsciousModeResponse,
} = require('../ConsciousMode');

type ConsciousModeStructuredResponse = import('../ConsciousMode').ConsciousModeStructuredResponse;

function createResponse(overrides: Partial<ConsciousModeStructuredResponse> = {}): ConsciousModeStructuredResponse {
  return {
    mode: 'reasoning_first',
    openingReasoning: overrides.openingReasoning ?? 'Start with the safest small step.',
    implementationPlan: overrides.implementationPlan ?? ['Ship the smallest viable boundary first'],
    tradeoffs: overrides.tradeoffs ?? [],
    edgeCases: overrides.edgeCases ?? [],
    scaleConsiderations: overrides.scaleConsiderations ?? [],
    pushbackResponses: overrides.pushbackResponses ?? [],
    likelyFollowUps: overrides.likelyFollowUps ?? [],
    codeTransition: overrides.codeTransition ?? '',
  };
}

function addInterviewerTurn(session: any, text: string, timestamp: number): void {
  session.handleTranscript({
    speaker: 'interviewer',
    text,
    timestamp,
    final: true,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createEngine() {
  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const engine = new IntelligenceEngine({} as any, session);
  return { engine, session };
}

test('manual typed input forks a safe manual branch without replacing the active live thread', async () => {
  const { engine, session } = createEngine();

  const liveResponse = createResponse({
    openingReasoning: 'I would start by isolating the write path first.',
    implementationPlan: ['Split write traffic behind a facade'],
  });
  const manualForkResponse = createResponse({
    openingReasoning: 'I would peel off the lowest-risk workflow first.',
    implementationPlan: ['Extract auth', 'Migrate one workflow', 'Watch error budgets'],
  });

  (engine as any).whatToAnswerLLM = {
    generateReasoningFirst: async (_transcript: string, question: string) => (
      question.includes('monolith') ? manualForkResponse : liveResponse
    ),
    generateStream: async function* () {
      yield 'fallback';
    },
  };
  (engine as any).answerLLM = {
    generate: async () => 'plain manual fallback',
    generateReasoningFirst: async () => createEmptyConsciousModeResponse('invalid'),
  };

  addInterviewerTurn(session, 'How would you design a write-heavy event pipeline?', Date.now() - 2_000);
  await engine.runWhatShouldISay(undefined, 0.85);

  const threadBefore = session.getActiveReasoningThread();
  const latestBefore = session.getLatestConsciousResponse();

  const answer = await engine.runManualAnswer('How would you migrate a monolith to services incrementally?');

  assert.equal(answer, formatConsciousModeResponse(manualForkResponse));
  assert.equal(session.getActiveReasoningThread()?.rootQuestion, threadBefore?.rootQuestion);
  assert.deepEqual(session.getLatestConsciousResponse(), latestBefore);
});

test('manual typed input attaches to the active thread only when the follow-up is clearly related', async () => {
  const { engine, session } = createEngine();

  const seedResponse = createResponse({
    openingReasoning: 'I would start with a single writer per shard.',
    implementationPlan: ['Partition by tenant'],
  });
  const followUpResponse = createResponse({
    openingReasoning: 'The tradeoff is operational complexity versus steady write latency.',
    tradeoffs: ['Shard rebalancing is more operationally complex'],
  });

  (engine as any).whatToAnswerLLM = {
    generateReasoningFirst: async () => seedResponse,
    generateStream: async function* () {
      yield 'fallback';
    },
  };
  (engine as any).followUpLLM = {
    generateReasoningFirstFollowUp: async () => followUpResponse,
  };
  (engine as any).answerLLM = {
    generate: async () => 'plain manual fallback',
    generateReasoningFirst: async () => createEmptyConsciousModeResponse('invalid'),
  };

  addInterviewerTurn(session, 'How would you design a write-heavy event pipeline?', Date.now() - 2_000);
  await engine.runWhatShouldISay(undefined, 0.85);

  const answer = await engine.runManualAnswer('Why this approach?');
  const thread = session.getActiveReasoningThread();

  assert.equal(answer, formatConsciousModeResponse(followUpResponse));
  assert.equal(thread?.rootQuestion, 'How would you design a write-heavy event pipeline?');
  assert.equal(thread?.followUpCount, 1);
  assert.deepEqual(thread?.response.tradeoffs, ['Shard rebalancing is more operationally complex']);
});

test('manual typed input during live fallback does not corrupt live thread memory', async () => {
  const { engine, session } = createEngine();

  const seedResponse = createResponse({
    openingReasoning: 'I would keep writes append-only first.',
    implementationPlan: ['Append to a durable log'],
  });
  const manualForkResponse = createResponse({
    openingReasoning: 'I would migrate one bounded context at a time.',
    implementationPlan: ['Pick one workflow', 'Add backfill', 'Cut traffic gradually'],
  });
  const invalidTangent = deferred<ConsciousModeStructuredResponse>();

  (engine as any).whatToAnswerLLM = {
    generateReasoningFirst: async (_transcript: string, question: string) => {
      if (question.includes('monolith')) {
        return manualForkResponse;
      }
      if (question.includes('deployment pipeline')) {
        return invalidTangent.promise;
      }
      return seedResponse;
    },
    generateStream: async function* () {
      yield 'Use a smoke test plus staged rollout.';
    },
  };

  addInterviewerTurn(session, 'How would you design a write-heavy event pipeline?', Date.now() - 3_000);
  await engine.runWhatShouldISay(undefined, 0.85);
  const originalThread = session.getActiveReasoningThread();

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'Quick tangent: how would you test the deployment pipeline?', Date.now() - 1_000);
  const livePromise = engine.runWhatShouldISay(undefined, 0.85);
  const manualPromise = engine.runManualAnswer('How would you migrate a monolith to services incrementally?');

  invalidTangent.resolve(createEmptyConsciousModeResponse('invalid'));

  await Promise.all([livePromise, manualPromise]);

  assert.equal(session.getActiveReasoningThread()?.rootQuestion, originalThread?.rootQuestion);
  assert.equal(session.getActiveReasoningThread()?.state, 'active');
  assert.equal(session.getSuspendedReasoningThread(), null);
});

test('newer live cycles supersede stale manual completions before they render or persist', async () => {
  const { engine, session } = createEngine();
  const manualResult = deferred<string>();
  const liveResult = deferred<ConsciousModeStructuredResponse>();
  const manualEvents: Array<{ answer: string; question: string }> = [];
  const liveEvents: string[] = [];

  (engine as any).answerLLM = {
    generate: async () => manualResult.promise,
    generateReasoningFirst: async () => createEmptyConsciousModeResponse('invalid'),
  };
  (engine as any).whatToAnswerLLM = {
    generateReasoningFirst: async () => liveResult.promise,
    generateStream: async function* () {
      yield 'fallback';
    },
  };

  engine.on('manual_answer_result', (answer: string, question: string) => {
    manualEvents.push({ answer, question });
  });
  engine.on('suggested_answer', (answer: string) => {
    liveEvents.push(answer);
  });

  const manualPromise = engine.runManualAnswer('Give me a concise answer for conflict resolution.');
  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'How would you design a write-heavy event pipeline?', Date.now() - 500);
  const livePromise = engine.runWhatShouldISay(undefined, 0.85);

  manualResult.resolve('stale manual answer');
  liveResult.resolve(createResponse({ openingReasoning: 'I would isolate the write path behind one durable queue.' }));

  await Promise.all([manualPromise, livePromise]);

  assert.deepEqual(manualEvents, []);
  assert.equal(liveEvents.length, 1);
  assert.equal(session.getLastAssistantMessage(), liveEvents[0]);
});
