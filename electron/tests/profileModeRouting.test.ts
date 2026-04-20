import test from 'node:test';
import assert from 'node:assert/strict';
import { IntelligenceEngine } from '../IntelligenceEngine';
import { SessionTracker } from '../SessionTracker';
import { AnswerLatencyTracker } from '../latency/AnswerLatencyTracker';
import { FAST_STANDARD_ANSWER_PROMPT } from '../llm/prompts';

type KnowledgeResult = {
  systemPromptInjection?: string;
  contextBlock?: string;
  isIntroQuestion?: boolean;
  introResponse?: string;
};

type StreamCall = {
  message: string;
  context?: string;
  prompt?: string;
  options?: { skipKnowledgeInterception?: boolean; qualityTier?: 'fast' | 'quality' | 'verify' };
  startedAt: number;
};

class CapturingLatencyTracker extends AnswerLatencyTracker {
  public completedSnapshots: Array<ReturnType<AnswerLatencyTracker['complete']>> = [];

  override complete(requestId: string) {
    const snapshot = super.complete(requestId);
    this.completedSnapshots.push(snapshot);
    return snapshot;
  }
}

class FakeLLMHelper {
  public calls: StreamCall[] = [];

  constructor(
    private readonly knowledgeStatus: { activeMode?: string; hasResume?: boolean; hasActiveJD?: boolean },
    private readonly processQuestionImpl: (question: string) => Promise<KnowledgeResult | null>,
    private readonly answer: string = 'generic fast answer',
  ) {}

  getProviderCapabilityClass() {
    return 'streaming' as const;
  }

  getKnowledgeOrchestrator() {
    return {
      isKnowledgeMode: () => true,
      getStatus: () => this.knowledgeStatus,
      processQuestion: this.processQuestionImpl,
    };
  }

  async *streamChat(
    message: string,
    _imagePaths?: string[],
    context?: string,
    prompt?: string,
    options?: { skipKnowledgeInterception?: boolean; qualityTier?: 'fast' | 'quality' | 'verify' },
  ): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt, options, startedAt: Date.now() });
    yield this.answer;
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

test('profile-required questions degrade to the fast route after the 250 ms enrichment budget expires', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper(
    { activeMode: 'profile', hasResume: true, hasActiveJD: false },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { contextBlock: 'resume grounding' };
    },
  );
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const latencyTracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = latencyTracker;

  addInterviewerTurn(session, 'Tell me about yourself.', Date.now());

  const startedAt = Date.now();
  const answer = await engine.runWhatShouldISay(undefined, 0.91);
  const snapshot = latencyTracker.completedSnapshots[0];

  assert.equal(answer, 'generic fast answer');
  assert.equal(llmHelper.calls.length, 1);
  assert.equal(llmHelper.calls[0].message, 'Tell me about yourself.');
  assert.equal(llmHelper.calls[0].prompt, FAST_STANDARD_ANSWER_PROMPT);
  assert.equal(llmHelper.calls[0].options?.skipKnowledgeInterception, true);
  assert.equal(snapshot?.attemptedRoute, 'enriched_standard_answer');
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.fallbackOccurred, true);
  assert.equal(snapshot?.profileFallbackReason, 'profile_timeout');
  assert.equal(snapshot?.profileEnrichmentState, 'timed_out');
  assert.ok((snapshot?.marks.providerRequestStarted ?? 0) - startedAt < 400);
});

test('profile-required questions record an explicit error fallback reason when enrichment throws', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper(
    { activeMode: 'profile', hasResume: true, hasActiveJD: false },
    async () => {
      throw new Error('knowledge enrichment failed');
    },
  );
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const latencyTracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = latencyTracker;

  addInterviewerTurn(session, 'Walk me through your resume.', Date.now());

  const answer = await engine.runWhatShouldISay(undefined, 0.9);
  const snapshot = latencyTracker.completedSnapshots[0];

  assert.equal(answer, 'generic fast answer');
  assert.equal(llmHelper.calls[0].prompt, FAST_STANDARD_ANSWER_PROMPT);
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.attemptedRoute, 'enriched_standard_answer');
  assert.equal(snapshot?.fallbackOccurred, true);
  assert.equal(snapshot?.profileFallbackReason, 'profile_error');
  assert.equal(snapshot?.profileEnrichmentState, 'failed');
});

test('profile-required questions record an explicit no-context fallback reason when enrichment returns nothing usable', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper(
    { activeMode: 'profile', hasResume: true, hasActiveJD: false },
    async () => ({ contextBlock: '   ', systemPromptInjection: '' }),
  );
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const latencyTracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = latencyTracker;

  addInterviewerTurn(session, 'Tell me about a project you worked on.', Date.now());

  const answer = await engine.runWhatShouldISay(undefined, 0.9);
  const snapshot = latencyTracker.completedSnapshots[0];

  assert.equal(answer, 'generic fast answer');
  assert.equal(llmHelper.calls[0].prompt, FAST_STANDARD_ANSWER_PROMPT);
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.attemptedRoute, 'enriched_standard_answer');
  assert.equal(snapshot?.fallbackOccurred, true);
  assert.equal(snapshot?.profileFallbackReason, 'profile_no_context');
  assert.equal(snapshot?.profileEnrichmentState, 'failed');
});

test('generic technical latest questions stay on the fast route even when profile mode is enabled', async () => {
  const session = new SessionTracker();
  const llmHelper = new FakeLLMHelper(
    { activeMode: 'profile', hasResume: true, hasActiveJD: false },
    async () => ({ contextBlock: 'resume grounding' }),
  );
  const engine = new IntelligenceEngine(llmHelper as any, session);
  const latencyTracker = new CapturingLatencyTracker();
  (engine as any).latencyTracker = latencyTracker;

  addInterviewerTurn(session, 'Tell me about yourself.', Date.now() - 3000);
  session.addAssistantMessage('I build distributed backend systems.');
  addInterviewerTurn(session, 'How would you design a rate limiter?', Date.now());

  const answer = await engine.runWhatShouldISay(undefined, 0.89);
  const snapshot = latencyTracker.completedSnapshots[0];

  assert.equal(answer, 'generic fast answer');
  assert.equal(llmHelper.calls.length, 1);
  assert.equal(llmHelper.calls[0].message, 'How would you design a rate limiter?');
  assert.equal(llmHelper.calls[0].prompt, FAST_STANDARD_ANSWER_PROMPT);
  assert.equal(llmHelper.calls[0].options?.skipKnowledgeInterception, true);
  assert.equal(snapshot?.route, 'fast_standard_answer');
  assert.equal(snapshot?.attemptedRoute, undefined);
  assert.equal(snapshot?.profileFallbackReason, undefined);
  assert.equal(snapshot?.profileEnrichmentState, undefined);
});
