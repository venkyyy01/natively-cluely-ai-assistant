import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';
import {
  PerformanceInstrumentation,
  setPerformanceInstrumentationForTesting,
} from '../runtime/PerformanceInstrumentation';

class TestIntelligenceEngine extends IntelligenceEngine {
  protected override async classifyIntentForRoute(_lastInterviewerTurn: string | null, _preparedTranscript: string, _assistantResponseCount: number) {
    return { intent: 'general' as const, answerShape: 'concise', confidence: 1, provider: 'test', retryCount: 0 };
  }
}

class CapturingLatencyTracker extends AnswerLatencyTracker {
  public completedSnapshots: Array<ReturnType<AnswerLatencyTracker['complete']>> = [];
  public visibleUpdateCalls = 0;

  override mark(requestId: string, label: string) {
    super.mark(requestId, label);
  }

  override markFirstStreamingUpdate(requestId: string) {
    this.visibleUpdateCalls += 1;
    super.markFirstStreamingUpdate(requestId);
  }

  override markFirstVisibleAnswer(requestId: string) {
    this.visibleUpdateCalls += 1;
    super.markFirstVisibleAnswer(requestId);
  }

  override complete(requestId: string) {
    const snapshot = super.complete(requestId);
    this.completedSnapshots.push(snapshot);
    return snapshot;
  }
}

class FakeLLMHelper {
  constructor(
    private readonly capability: 'streaming' | 'buffered' | 'non_streaming' = 'streaming',
    private readonly knowledgeStatus?: { activeMode?: string; hasResume?: boolean; hasActiveJD?: boolean },
    private readonly streamChunks: string[] = ['profile answer'],
    private readonly streamError?: Error,
    private readonly streamErrorAfterChunkIndex: number | null = null,
    private readonly structuredResponseOverride?: string,
    private readonly preStreamDelayMs: number = 0,
  ) {}

  getProviderCapabilityClass() {
    return this.capability;
  }

  getKnowledgeOrchestrator() {
    return this.knowledgeStatus
      ? { getStatus: () => this.knowledgeStatus }
      : null;
  }

  async *streamChat(message: string): AsyncGenerator<string> {
    if (message.includes('STRUCTURED_REASONING_RESPONSE')) {
      yield this.structuredResponseOverride ?? JSON.stringify({
        mode: 'reasoning_first',
        openingReasoning: 'I would start with the core tradeoffs first.',
        implementationPlan: ['Clarify constraints'],
        tradeoffs: ['More upfront discussion'],
        edgeCases: ['Changing requirements'],
        scaleConsiderations: ['More stakeholders'],
        pushbackResponses: ['I optimized for clarity first.'],
        likelyFollowUps: ['How would you phase it?'],
        codeTransition: 'Then I would connect that to an implementation sketch.',
      });
      return;
    }

    if (this.streamError) {
      if (this.preStreamDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.preStreamDelayMs));
      }
      throw this.streamError;
    }

    for (const [index, chunk] of this.streamChunks.entries()) {
      yield chunk;
      if (this.streamErrorAfterChunkIndex === index) {
        throw new Error('mid-stream failure');
      }
    }
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

test('AnswerLatencyTracker records route, capability, marks, and completion safely', () => {
  const tracker = new AnswerLatencyTracker();
  const requestId = tracker.start('fast_standard_answer', 'streaming');

  tracker.mark(requestId, 'promptPrepared');
  const beforeComplete = tracker.getSnapshot(requestId);
  assert.equal(beforeComplete?.route, 'fast_standard_answer');
  assert.equal(beforeComplete?.capability, 'streaming');
  assert.ok(beforeComplete?.marks.startedAt);
  assert.ok(beforeComplete?.marks.promptPrepared);

  const completed = tracker.complete(requestId);
  assert.equal(completed?.completed, true);
  assert.ok(completed?.marks.completedAt);

  tracker.mark(requestId, 'shouldBeIgnored');
  const afterComplete = tracker.getSnapshot(requestId);
  assert.equal(afterComplete?.marks.shouldBeIgnored, undefined);
});

test('AnswerLatencyTracker records extended SLO metadata on snapshots', () => {
  const tracker = new AnswerLatencyTracker();
  const trackerWithMetadata = tracker as AnswerLatencyTracker & {
    annotate(requestId: string, metadata: {
      transcriptRevision?: number;
      fallbackOccurred?: boolean;
      profileFallbackReason?: string;
      interimQuestionSubstitutionOccurred?: boolean;
      profileEnrichmentState?: 'attempted' | 'completed' | 'failed' | 'timed_out';
      consciousPath?: 'fresh_start' | 'thread_continue';
      firstVisibleAnswer?: number;
      contextItemIds?: string[];
      verifierOutcome?: { deterministic: 'pass' | 'fail' | 'skipped'; provenance: 'pass' | 'fail' | 'skipped' };
      stealthContainmentActive?: boolean;
    }): void;
  };
  const snapshotWithMetadata = (snapshot: unknown) => snapshot as {
    route: string;
    capability: string;
    requestId: string;
    marks: Record<string, number>;
    firstVisibleAnswer?: number;
    transcriptRevision?: number;
    fallbackOccurred?: boolean;
      profileFallbackReason?: string;
      interimQuestionSubstitutionOccurred?: boolean;
      profileEnrichmentState?: 'attempted' | 'completed' | 'failed' | 'timed_out';
      consciousPath?: 'fresh_start' | 'thread_continue';
      contextItemIds?: string[];
      verifierOutcome?: { deterministic: 'pass' | 'fail' | 'skipped'; provenance: 'pass' | 'fail' | 'skipped' };
      stealthContainmentActive?: boolean;
    };

  const requestId = tracker.start('conscious_answer', 'non_streaming');
  tracker.markFirstStreamingUpdate(requestId);
  trackerWithMetadata.annotate(requestId, {
    transcriptRevision: 7,
    fallbackOccurred: true,
    profileFallbackReason: 'profile_timeout',
    interimQuestionSubstitutionOccurred: true,
    profileEnrichmentState: 'timed_out',
    consciousPath: 'thread_continue',
    firstVisibleAnswer: 1234,
    contextItemIds: ['interviewer:1:0'],
    verifierOutcome: { deterministic: 'pass', provenance: 'pass' },
    stealthContainmentActive: false,
  });

  const snapshot = snapshotWithMetadata(tracker.complete(requestId));
  assert.equal(snapshot.route, 'conscious_answer');
  assert.equal(snapshot.capability, 'non_streaming_custom');
  assert.equal(snapshot.requestId, requestId);
  assert.equal(snapshot.marks.firstToken, undefined);
  assert.equal(snapshot.marks.firstVisibleAnswer !== undefined, true);
  assert.equal(snapshot.firstVisibleAnswer, snapshot.marks.firstVisibleAnswer);
  assert.equal(snapshot.firstVisibleAnswer, 1234);
  assert.equal(snapshot.transcriptRevision, 7);
  assert.equal(snapshot.fallbackOccurred, true);
  assert.equal(snapshot.profileFallbackReason, 'profile_timeout');
  assert.equal(snapshot.interimQuestionSubstitutionOccurred, true);
  assert.equal(snapshot.profileEnrichmentState, 'timed_out');
  assert.equal(snapshot.consciousPath, 'thread_continue');
  assert.deepEqual(snapshot.contextItemIds, ['interviewer:1:0']);
  assert.deepEqual(snapshot.verifierOutcome, { deterministic: 'pass', provenance: 'pass' });
  assert.equal(snapshot.stealthContainmentActive, false);
});

test('AnswerLatencyTracker covers all capability classes and uses firstVisibleAnswer mark for non-streaming visibility', () => {
  const tracker = new AnswerLatencyTracker();

  const streamingId = tracker.start('fast_standard_answer', 'streaming');
  const bufferedId = tracker.start('manual_answer', 'buffered');
  const nonStreamingId = tracker.start('conscious_answer', 'non_streaming');

  tracker.markFirstStreamingUpdate(streamingId);
  tracker.markFirstVisibleAnswer(bufferedId);
  tracker.markFirstStreamingUpdate(nonStreamingId);

  const streamingSnapshot = tracker.getSnapshot(streamingId);
  const bufferedSnapshot = tracker.getSnapshot(bufferedId);
  const nonStreamingSnapshot = tracker.getSnapshot(nonStreamingId);

  assert.equal(streamingSnapshot?.capability, 'streaming');
  assert.equal(streamingSnapshot?.marks.firstToken !== undefined, true);
  assert.equal(streamingSnapshot?.marks.firstVisibleAnswer, streamingSnapshot?.marks.firstToken);
  assert.equal(bufferedSnapshot?.capability, 'buffered');
  assert.equal(bufferedSnapshot?.marks.firstToken, undefined);
  assert.equal(bufferedSnapshot?.marks.firstVisibleAnswer !== undefined, true);
  assert.equal(nonStreamingSnapshot?.capability, 'non_streaming_custom');
  assert.equal(nonStreamingSnapshot?.marks.firstToken, undefined);
  assert.equal(nonStreamingSnapshot?.marks.firstVisibleAnswer !== undefined, true);
  assert.equal(nonStreamingSnapshot?.firstVisibleAnswer, nonStreamingSnapshot?.marks.firstVisibleAnswer);
  assert.equal(nonStreamingSnapshot?.profileEnrichmentState, undefined);
});

test('AnswerLatencyTracker records answer.firstVisible from first visibility, not completion time', async () => {
  const benchmarkDir = await mkdtemp(join(tmpdir(), 'answer-latency-metric-'));
  const originalDateNow = Date.now;
  let now = 2_000;
  Date.now = () => now;
  const instrumentation = new PerformanceInstrumentation({
    logDirectory: benchmarkDir,
    now: () => now,
  });
  setPerformanceInstrumentationForTesting(instrumentation);

  try {
    const tracker = new AnswerLatencyTracker();
    const requestId = tracker.start('fast_standard_answer', 'streaming');

    now += 42;
    tracker.markFirstStreamingUpdate(requestId);
    now += 300;
    tracker.complete(requestId);

    await instrumentation.flush();
    const firstVisibleMetric = (await instrumentation.readAll()).find((event) => event.metric === 'answer.firstVisible');
    assert.equal(firstVisibleMetric?.durationMs, 42);
  } finally {
    Date.now = originalDateNow;
    setPerformanceInstrumentationForTesting(null);
    await rm(benchmarkDir, { recursive: true, force: true });
  }
});

test('IntelligenceEngine records conscious route provider start metadata', async () => {
  const consciousSession = new SessionTracker();
  const consciousEngine = new TestIntelligenceEngine(new FakeLLMHelper('non_streaming') as any, consciousSession);
  const consciousTracker = new CapturingLatencyTracker();
  (consciousEngine as any).latencyTracker = consciousTracker;

  consciousSession.setConsciousModeEnabled(true);
  addInterviewerTurn(consciousSession, 'How would you design a rate limiter for an API?', Date.now());

  await consciousEngine.runWhatShouldISay(undefined, 0.9);

  const consciousSnapshot = consciousTracker.completedSnapshots[0];
  assert.equal(consciousSnapshot?.route, 'conscious_answer');
  assert.equal(consciousSnapshot?.capability, 'non_streaming_custom');
  assert.equal(consciousSnapshot?.marks.providerRequestStarted !== undefined, true);
  assert.equal(consciousSnapshot?.marks.firstVisibleAnswer !== undefined, true);
  assert.equal((consciousSnapshot?.contextItemIds?.length ?? 0) > 0, true);
  assert.deepEqual(consciousSnapshot?.verifierOutcome, { deterministic: 'pass', provenance: 'pass' });
  assert.equal(consciousSnapshot?.stealthContainmentActive, false);
  assert.equal(
    (consciousSnapshot?.marks.providerRequestStarted ?? 0) <= (consciousSnapshot?.marks.firstVisibleAnswer ?? 0),
    true,
  );
});

test('IntelligenceEngine marks first visible streaming update on first token and records enriched lifecycle outcomes', async () => {
  const successSession = new SessionTracker();
  const successEngine = new TestIntelligenceEngine(
    new FakeLLMHelper('streaming', { activeMode: 'profile', hasResume: true, hasActiveJD: false }, ['first ', 'second']) as any,
    successSession,
  );
  const successTracker = new CapturingLatencyTracker();
  (successEngine as any).latencyTracker = successTracker;

  addInterviewerTurn(successSession, 'Tell me about yourself.', Date.now());
  await successEngine.runWhatShouldISay(undefined, 0.9);

  const successSnapshot = successTracker.completedSnapshots[0];
  assert.equal(successSnapshot?.profileEnrichmentState, 'completed');
  assert.equal(successSnapshot?.marks.firstToken !== undefined, true);
  assert.equal(successSnapshot?.marks.firstVisibleAnswer !== undefined, true);
  assert.equal(successSnapshot?.marks.firstToken, successSnapshot?.marks.firstVisibleAnswer);
  assert.equal(successTracker.visibleUpdateCalls, 1);

  const failedSession = new SessionTracker();
  const failedEngine = new TestIntelligenceEngine(
    new FakeLLMHelper(
      'streaming',
      { activeMode: 'profile', hasResume: true, hasActiveJD: false },
      [],
      new Error('profile enrichment failed'),
    ) as any,
    failedSession,
  );
  const failedTracker = new CapturingLatencyTracker();
  (failedEngine as any).latencyTracker = failedTracker;

  addInterviewerTurn(failedSession, 'Tell me about yourself.', Date.now());
  await failedEngine.runWhatShouldISay(undefined, 0.9);

  const failedSnapshot = failedTracker.completedSnapshots[0];
  assert.equal(failedSnapshot?.profileEnrichmentState, 'failed');
  assert.equal(failedSnapshot?.profileFallbackReason, 'profile_error');
  assert.equal(failedSnapshot?.fallbackOccurred, true);
  assert.equal(failedSnapshot?.marks.firstToken, undefined);
  assert.equal(failedSnapshot?.marks.firstVisibleAnswer !== undefined, true);

  const timedOutSession = new SessionTracker();
  const timedOutEngine = new TestIntelligenceEngine(
    new FakeLLMHelper(
      'streaming',
      { activeMode: 'profile', hasResume: true, hasActiveJD: false },
      [],
      new Error('LLM API timeout after 30000ms'),
    ) as any,
    timedOutSession,
  );
  const timedOutTracker = new CapturingLatencyTracker();
  (timedOutEngine as any).latencyTracker = timedOutTracker;

  addInterviewerTurn(timedOutSession, 'Tell me about yourself.', Date.now());
  await timedOutEngine.runWhatShouldISay(undefined, 0.9);

  const timedOutSnapshot = timedOutTracker.completedSnapshots[0];
  assert.equal(timedOutSnapshot?.profileEnrichmentState, 'timed_out');
  assert.equal(timedOutSnapshot?.profileFallbackReason, 'profile_timeout');
  assert.equal(timedOutSnapshot?.fallbackOccurred, true);
  assert.equal(timedOutSnapshot?.marks.firstToken, undefined);
  assert.equal(timedOutSnapshot?.marks.firstVisibleAnswer !== undefined, true);

  const midStreamSession = new SessionTracker();
  const midStreamEngine = new TestIntelligenceEngine(
    new FakeLLMHelper(
      'streaming',
      { activeMode: 'profile', hasResume: true, hasActiveJD: false },
      ['partial '],
      undefined,
      0,
    ) as any,
    midStreamSession,
  );
  const midStreamTracker = new CapturingLatencyTracker();
  (midStreamEngine as any).latencyTracker = midStreamTracker;

  addInterviewerTurn(midStreamSession, 'Tell me about yourself.', Date.now());
  await midStreamEngine.runWhatShouldISay(undefined, 0.9);

  const midStreamSnapshot = midStreamTracker.completedSnapshots[0];
  assert.equal(midStreamSnapshot?.profileEnrichmentState, 'completed');
  assert.equal(midStreamSnapshot?.profileFallbackReason, undefined);
  assert.equal(midStreamSnapshot?.fallbackOccurred, false);
});

test('IntelligenceEngine leaves non-profile failures outside profile lifecycle instrumentation', async () => {
  const session = new SessionTracker();
  const engine = new TestIntelligenceEngine(
    new FakeLLMHelper('streaming', undefined, [], new Error('generic fast-path failure')) as any,
    session,
  );
  const tracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = tracker;

  addInterviewerTurn(session, 'What is polymorphism?', Date.now());
  await engine.runWhatShouldISay(undefined, 0.9);

  const snapshot = tracker.completedSnapshots[0];
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.profileEnrichmentState, undefined);
  assert.equal(snapshot?.profileFallbackReason, undefined);
  assert.equal(snapshot?.fallbackOccurred, true);
});

test('IntelligenceEngine reclassifies conscious fallback to the actual standard-answer route', async () => {
  const session = new SessionTracker();
  const engine = new TestIntelligenceEngine(
    new FakeLLMHelper('streaming', undefined, ['fallback answer'], undefined, null, 'not valid json') as any,
    session,
  );
  const tracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = tracker;

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'How would you design a rate limiter for an API?', Date.now());

  await engine.runWhatShouldISay(undefined, 0.9);

  const snapshot = tracker.completedSnapshots[0];
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.attemptedRoute, 'conscious_answer');
  assert.equal(snapshot?.consciousPath, 'fresh_start');
  assert.equal(snapshot?.fallbackOccurred, true);
  assert.equal(snapshot?.marks.firstToken !== undefined, true);
});

test('IntelligenceEngine initializes profile lifecycle when conscious fallback reclassifies to enriched route', async () => {
  const session = new SessionTracker();
  const engine = new TestIntelligenceEngine(
    new FakeLLMHelper(
      'streaming',
      { activeMode: 'profile', hasResume: true, hasActiveJD: false },
      ['enriched fallback'],
      undefined,
      null,
      'not valid json',
    ) as any,
    session,
  );
  const tracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = tracker;

  session.setConsciousModeEnabled(true);
  addInterviewerTurn(session, 'Walk me through your background and how would you design a rate limiter?', Date.now());

  await engine.runWhatShouldISay(undefined, 0.9);

  const snapshot = tracker.completedSnapshots[0];
  assert.equal(snapshot?.route, 'enriched_standard_answer');
  assert.equal(snapshot?.attemptedRoute, 'conscious_answer');
  assert.equal(snapshot?.fallbackOccurred, true);
  assert.equal(snapshot?.profileEnrichmentState, 'completed');
});

test('IntelligenceEngine does not mark fallbackOccurred for superseded fallback output', async () => {
  const session = new SessionTracker();
  const engine = new TestIntelligenceEngine(
    new FakeLLMHelper('streaming', undefined, [], new Error('delayed failure'), null, undefined, 20) as any,
    session,
  );
  const tracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = tracker;

  addInterviewerTurn(session, 'What is polymorphism?', Date.now() - 10);
  const firstRequest = engine.runWhatShouldISay(undefined, 0.9);

  (engine as any).lastTriggerTime = 0;
  addInterviewerTurn(session, 'Explain encapsulation.', Date.now());
  const secondRequest = engine.runWhatShouldISay(undefined, 0.9);

  await Promise.all([firstRequest, secondRequest]);

  const staleSnapshot = tracker.completedSnapshots.find(
    (snapshot) => snapshot?.route === 'fast_standard_answer' && snapshot?.marks.firstToken === undefined,
  );
  assert.equal(staleSnapshot?.fallbackOccurred, false);
});

test('IntelligenceEngine emits suggested answer metadata for duplicate cooldown deferrals', async () => {
  class SlowStreamingLLMHelper {
    async *streamChat(): AsyncGenerator<string> {
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield 'slow answer';
    }
  }

  const session = new SessionTracker();
  const engine = new TestIntelligenceEngine(new SlowStreamingLLMHelper() as any, session);
  const metadataByAnswer: Array<{ cooldownSuppressedMs?: number; cooldownReason?: string }> = [];
  const deferredEvents: Array<{ suppressedMs: number; question?: string; reason?: string }> = [];

  (engine as any).triggerCooldown = 20;
  engine.on('suggested_answer', (_answer: string, _question: string, _confidence: number, metadata?: { cooldownSuppressedMs?: number; cooldownReason?: string }) => {
    metadataByAnswer.push({ cooldownSuppressedMs: metadata?.cooldownSuppressedMs, cooldownReason: metadata?.cooldownReason });
  });
  engine.on('cooldown_deferred', (suppressedMs: number, question?: string, reason?: string) => {
    deferredEvents.push({ suppressedMs, question, reason });
  });

  addInterviewerTurn(session, 'Same question?', Date.now() - 200);
  const first = await engine.runWhatShouldISay(undefined, 0.9);
  assert.equal(first, 'slow answer');

  (engine as any).setMode('idle');
  addInterviewerTurn(session, 'Same question?', Date.now());
  const second = await engine.runWhatShouldISay(undefined, 0.9);

  assert.equal(second, 'slow answer');
  assert.equal(deferredEvents.length, 1);
  assert.equal((deferredEvents[0]?.suppressedMs ?? 0) > 0, true);
  assert.equal(deferredEvents[0]?.question, 'Same question?');
  assert.equal(deferredEvents[0]?.reason, 'duplicate_question_debounce');
  assert.equal(metadataByAnswer[0]?.cooldownSuppressedMs, undefined);
  assert.equal((metadataByAnswer[1]?.cooldownSuppressedMs ?? 0) > 0, true);
  assert.equal(metadataByAnswer[1]?.cooldownReason, 'duplicate_question_debounce');
});
