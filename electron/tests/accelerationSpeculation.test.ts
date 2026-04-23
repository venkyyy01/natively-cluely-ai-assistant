import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { AccelerationManager, setActiveAccelerationManager } from '../services/AccelerationManager';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';
import { setEmbeddingProvider } from '../cache/ParallelContextAssembler';

class DelayedFastLLMHelper {
  public calls: Array<{ message: string; context?: string; prompt?: string }> = [];

  async *streamChat(message: string, _imagePaths?: string[], context?: string, prompt?: string): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt });
    await new Promise((resolve) => setTimeout(resolve, 40));
    yield `speculative answer for: ${message}`;
  }
}

class ChunkedFastLLMHelper {
  public calls: Array<{ message: string; context?: string; prompt?: string }> = [];

  async *streamChat(message: string, _imagePaths?: string[], context?: string, prompt?: string): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt });
    yield 'speculative ';
    await new Promise((resolve) => setTimeout(resolve, 40));
    yield `answer for: ${message}`;
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

function installTestEmbeddingProvider(): void {
  setEmbeddingProvider({
    isInitialized: () => true,
    embed: async (text: string) => {
      const lower = text.toLowerCase();
      if (lower.includes('component')) {
        return [1, 0, 0];
      }
      if (lower.includes('scale')) {
        return [0, 1, 0];
      }
      if (lower.includes('polymorphism') || lower.includes('encapsulation')) {
        return [0, 0, 1];
      }

      return [0.5, 0.5, 0.5];
    },
  });
}

function resetAccelerationTestState(): void {
  setActiveAccelerationManager(null);
  setEmbeddingProvider(null);
  setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS });
}

test('speculative fast answer is reused by the live what-to-say path', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const llmHelper = new DelayedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const metadataSeen: Array<{ verifier?: { deterministic: string; provenance: string } }> = [];
  engine.on('suggested_answer', (_answer: string, _question: string, _confidence: number, metadata?: { verifier?: { deterministic: string; provenance: string } }) => {
    metadataSeen.push({ verifier: metadata?.verifier });
  });
  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  installTestEmbeddingProvider();
  accelerationManager.setConsciousModeEnabled(true);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  consciousAcceleration.setIntentClassifier(async () => ({
    intent: 'coding',
    confidence: 0.93,
    answerShape: 'Provide a full implementation.',
  }));
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );

  consciousAcceleration.onSilenceStart('What is polymorphism?');
  await new Promise((resolve) => setTimeout(resolve, 700));

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: What is polymorphism?');
  assert.equal(llmHelper.calls.some((call) => call.message === 'What is polymorphism?'), true);
  assert.deepEqual(metadataSeen, [{ verifier: { deterministic: 'skipped', provenance: 'skipped' } }]);

  resetAccelerationTestState();
});

test('speculative answers are invalidated when transcript revision changes', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const llmHelper = new DelayedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  installTestEmbeddingProvider();
  accelerationManager.setConsciousModeEnabled(true);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  consciousAcceleration.setIntentClassifier(async () => ({
    intent: 'coding',
    confidence: 0.93,
    answerShape: 'Provide a full implementation.',
  }));
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now() - 1000);
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  consciousAcceleration.onSilenceStart('What is polymorphism?');

  await new Promise((resolve) => setTimeout(resolve, 120));

  addTurn(session, 'interviewer', 'Explain encapsulation.', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'Explain encapsulation.');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: Explain encapsulation.');
  assert.equal(llmHelper.calls.some((call) => call.message === 'Explain encapsulation.'), true);

  resetAccelerationTestState();
});

test('speculative acceleration stays disabled when conscious mode is off', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(false);
  const llmHelper = new DelayedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  installTestEmbeddingProvider();
  accelerationManager.setConsciousModeEnabled(false);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  accelerationManager.getEnhancedCache().set(
    `answer:${session.getTranscriptRevision()}:fast:${'What is polymorphism?'.toLowerCase()}`,
    'cached answer that should be ignored'
  );
  consciousAcceleration.onSilenceStart('What is polymorphism?');

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(await consciousAcceleration.getSpeculativeAnswer('What is polymorphism?', session.getTranscriptRevision(), 0), null);

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: What is polymorphism?');
  assert.equal(llmHelper.calls.length, 1);

  resetAccelerationTestState();
});

test('speculative answers stream early tokens before the final answer is committed', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const llmHelper = new ChunkedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const tokenEvents: string[] = [];
  engine.on('suggested_answer_token', (token: string) => {
    tokenEvents.push(token);
  });

  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  installTestEmbeddingProvider();
  accelerationManager.setConsciousModeEnabled(true);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  consciousAcceleration.setIntentClassifier(async () => ({
    intent: 'coding',
    confidence: 0.93,
    answerShape: 'Provide a full implementation.',
  }));
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  await (consciousAcceleration as any).maybePrefetchIntent();
  await (consciousAcceleration as any).maybeStartSpeculativeAnswer();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const answer = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(answer, 'speculative answer for: What is polymorphism?');
  assert.deepEqual(tokenEvents, ['speculative ', 'answer for: What is polymorphism?']);

  resetAccelerationTestState();
});

test('stealth containment stops speculative suffixes and final answers after the first preview token', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useParallelContext: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const session = new SessionTracker();
  session.setConsciousModeEnabled(true);
  const llmHelper = new ChunkedFastLLMHelper();
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const tokenEvents: string[] = [];
  const finalAnswers: string[] = [];
  let containmentActivated = false;

  engine.on('suggested_answer_token', (token: string) => {
    tokenEvents.push(token);
    if (!containmentActivated) {
      containmentActivated = true;
      (engine as any).setStealthContainmentActive(true);
    }
  });
  engine.on('suggested_answer', (answer: string) => {
    finalAnswers.push(answer);
  });

  const accelerationManager = new AccelerationManager();
  await accelerationManager.initialize();
  installTestEmbeddingProvider();
  accelerationManager.setConsciousModeEnabled(true);
  const consciousAcceleration = accelerationManager.getConsciousOrchestrator();
  consciousAcceleration.setIntentClassifier(async () => ({
    intent: 'coding',
    confidence: 0.93,
    answerShape: 'Provide a full implementation.',
  }));
  setActiveAccelerationManager(accelerationManager);
  engine.attachAccelerationManager(accelerationManager);

  addTurn(session, 'interviewer', 'What is polymorphism?', Date.now());
  consciousAcceleration.noteTranscriptText('interviewer', 'What is polymorphism?');
  consciousAcceleration.updateTranscriptSegments(
    session.getFullTranscript().slice(-50).map((entry) => ({
      text: entry.text,
      timestamp: entry.timestamp,
      speaker: entry.speaker,
    })),
    session.getTranscriptRevision(),
  );
  await (consciousAcceleration as any).maybePrefetchIntent();
  await (consciousAcceleration as any).maybeStartSpeculativeAnswer();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const answer = await Promise.race([
    engine.runWhatShouldISay(undefined, 0.9),
    new Promise<symbol>((_, reject) => setTimeout(() => reject(new Error('speculative stealth containment did not stop in time')), 200)),
  ]);

  assert.equal(answer, null);
  assert.deepEqual(tokenEvents, ['speculative ']);
  assert.deepEqual(finalAnswers, []);
  assert.equal(session.getLastAssistantMessage(), null);

  resetAccelerationTestState();
});

test('NAT-002: speculative selection refuses semantic hedging when the finalized question shifts', async () => {
  // Audit A-2 / NAT-002: the previous behavior was to fall back to a 0.72 cosine
  // match when the finalized query did not exactly equal the noted speculative
  // query. That allowed a *different* question to be answered with another
  // speculation's chunks. The contract is now: exact normalized-query match only.
  //
  // We deliberately use a transcript and a finalized question that do NOT
  // overlap with any PHASE_FOLLOWUP_PATTERNS template — otherwise the prefetcher
  // independently spawns a speculative entry for the template (e.g.
  // 'What are the main components?' is a high_level_design template), which
  // would *legitimately* match an exact-equality lookup and mask the bug we're
  // guarding against.
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });
  installTestEmbeddingProvider();
  const orchestrator = new AccelerationManager().getConsciousOrchestrator();
  orchestrator.setEnabled(true);
  orchestrator.setPhase('high_level_design');
  orchestrator.setIntentClassifier(async () => ({
    intent: 'deep_dive',
    confidence: 0.93,
    answerShape: 'Explain the tradeoffs directly.',
  }));
  const seedQuery = 'Walk me through the read path of your design end to end';
  orchestrator.noteTranscriptText('interviewer', seedQuery);
  orchestrator.updateTranscriptSegments([
    {
      speaker: 'interviewer',
      text: seedQuery,
      timestamp: Date.now(),
    },
  ], 1);
  orchestrator.setSpeculativeExecutor((query) => (async function* () {
    yield `answer for: ${query}`;
  })());

  await (orchestrator as any).maybePrefetchIntent();
  await (orchestrator as any).maybeStartSpeculativeAnswer();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Finalized question differs from any speculative entry the prefetcher could
  // have produced (the seed and the high_level_design templates don't mention
  // "consistency model"). Pre-NAT-002, a 0.72 cosine fallback would have bound
  // this question to the seed's chunks; post-NAT-002 we must return null.
  const answer = await orchestrator.getSpeculativeAnswer('What consistency model does it provide for cross-region writes?', 1, 200);
  assert.equal(answer, null);

  // Sanity: an exact normalized match still resolves the original speculation.
  const exact = await orchestrator.getSpeculativeAnswer(seedQuery, 1, 200);
  assert.equal(exact, `answer for: ${seedQuery}`);

  resetAccelerationTestState();
});

test('intent prefetch is discarded when speech resumes before the prefetched classification resolves', async () => {
  setOptimizationFlags({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    usePrefetching: true,
    useANEEmbeddings: false,
  });

  const orchestrator = new AccelerationManager().getConsciousOrchestrator();
  orchestrator.setEnabled(true);

  let resolveIntent!: (value: { intent: 'coding'; confidence: number; answerShape: string }) => void;
  orchestrator.setIntentClassifier(async () => {
    return await new Promise((resolve) => {
      resolveIntent = resolve;
    });
  });

  const query = 'What is polymorphism?';
  orchestrator.noteTranscriptText('interviewer', query);
  orchestrator.updateTranscriptSegments([
    {
      speaker: 'interviewer',
      text: query,
      timestamp: Date.now(),
    },
  ], 1);

  const prefetchPromise = (orchestrator as any).maybePrefetchIntent();
  orchestrator.onUserSpeaking();
  resolveIntent({
    intent: 'coding',
    confidence: 0.93,
    answerShape: 'Provide a full implementation.',
  });
  await prefetchPromise;

  assert.equal(orchestrator.getPrefetchedIntent(query, 1), null);

  resetAccelerationTestState();
});
