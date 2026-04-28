import {
  classifyConsciousModeQuestion,
  formatConsciousModeResponse,
  isValidConsciousModeResponse,
  type ConsciousModeQuestionRoute,
  type ConsciousModeStructuredResponse,
  type ReasoningThread,
  isBehavioralQuestionText,
} from '../ConsciousMode';
import type { QuestionReaction } from './QuestionReactionClassifier';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import { ConsciousAnswerPlanner } from './ConsciousAnswerPlanner';
import type { TemporalContext } from '../llm/TemporalContextBuilder';
import type { IntentResult } from '../llm/IntentClassifier';
import type { WhatToAnswerLLM } from '../llm/WhatToAnswerLLM';
import type { AnswerLLM } from '../llm/AnswerLLM';
import type { FollowUpLLM } from '../llm/FollowUpLLM';
import { selectAnswerRoute } from '../latency/answerRouteSelector';
import type { AnswerRoute } from '../latency/AnswerLatencyTracker';
import { ConsciousRetrievalOrchestrator } from './ConsciousRetrievalOrchestrator';
import { isStrongConsciousIntent, isUncertainConsciousIntent } from './ConsciousIntentService';
import { ConsciousProvenanceVerifier } from './ConsciousProvenanceVerifier';
import { ConsciousVerifier } from './ConsciousVerifier';
import { LayeredIntentRouter, isReliableIntent } from '../llm/LayeredIntentRouter';
import type { IntentClassificationCoordinator } from '../llm/providers/IntentClassificationCoordinator';
import { isVerifierOptimizationActive } from '../config/optimizations';
import { Metrics } from '../runtime/Metrics';

interface KnowledgeStatusLike {
  activeMode?: unknown;
  hasResume?: unknown;
  hasActiveJD?: unknown;
}

interface ConsciousSession {
  isConsciousModeEnabled(): boolean;
  getActiveReasoningThread(): ReasoningThread | null;
  getLatestConsciousResponse(): ConsciousModeStructuredResponse | null;
  clearConsciousModeThread(): void;
  getFormattedContext(lastSeconds: number): string;
  getConsciousEvidenceContext(): string;
  getConsciousSemanticContext(): string;
  getConsciousLongMemoryContext(question: string): string;
  getLatestQuestionReaction(): QuestionReaction | null;
  getLatestAnswerHypothesis(): AnswerHypothesis | null;
  recordConsciousResponse(
    question: string,
    response: ConsciousModeStructuredResponse,
    threadAction: 'start' | 'continue' | 'reset'
  ): void;
}

export interface PreparedConsciousRoute {
  preRouteDecision: ConsciousModeQuestionRoute;
  activeReasoningThread: ReasoningThread | null;
  selectedRoute: AnswerRoute;
  effectiveRoute: AnswerRoute;
  standardRouteAfterConsciousFallback: AnswerRoute;
}

export type ConsciousExecutionResult =
  | { kind: 'skip' }
  | { kind: 'fallback' }
  | {
      kind: 'handled';
      structuredResponse: ConsciousModeStructuredResponse;
      fullAnswer: string;
      verification: ConsciousVerificationMetadata;
    };

export interface ConsciousVerificationMetadata {
  deterministic: 'pass' | 'fail' | 'skipped';
  judge: 'pass' | 'fail' | 'skipped';
  provenance: 'pass' | 'fail' | 'skipped';
  reasons: string[];
}

export class ConsciousOrchestrator {
  private static readonly CIRCUIT_BREAKER_FAILURE_THRESHOLD = 6;
  private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 20_000;

  private readonly verifier = new ConsciousVerifier();
  private readonly retrievalOrchestrator: ConsciousRetrievalOrchestrator;
  private readonly answerPlanner = new ConsciousAnswerPlanner();
  private readonly provenanceVerifier = new ConsciousProvenanceVerifier();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(private readonly session: ConsciousSession, verifier?: ConsciousVerifier) {
    if (verifier) {
      this.verifier = verifier;
    }
    this.retrievalOrchestrator = new ConsciousRetrievalOrchestrator(this.session);
  }

  private isCircuitOpen(now: number = Date.now()): boolean {
    return now < this.circuitOpenUntil;
  }

  private recordExecutionSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordExecutionFailure(reason: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= ConsciousOrchestrator.CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + ConsciousOrchestrator.CIRCUIT_BREAKER_COOLDOWN_MS;
      console.warn('[ConsciousOrchestrator] Opening conscious-mode circuit breaker after repeated failures:', {
        reason,
        consecutiveFailures: this.consecutiveFailures,
        cooldownMs: ConsciousOrchestrator.CIRCUIT_BREAKER_COOLDOWN_MS,
      });
    }
  }

  private fallback(reason: string): ConsciousExecutionResult {
    this.recordExecutionFailure(reason);
    return { kind: 'fallback' };
  }

  private buildVerificationMetadata(input: {
    provenanceOk: boolean;
    provenanceReason?: string;
    verificationOk: boolean;
    verificationReason?: string;
    deterministic?: 'pass' | 'fail' | 'skipped';
    judge?: 'pass' | 'fail' | 'skipped';
  }): ConsciousVerificationMetadata {
    const reasons = [input.provenanceReason, input.verificationReason].filter((reason): reason is string => Boolean(reason));
    return {
      deterministic: input.deterministic ?? (input.verificationOk ? 'pass' : 'fail'),
      judge: input.judge ?? 'skipped',
      provenance: input.provenanceOk ? 'pass' : 'fail',
      reasons,
    };
  }

  private static readonly THREAD_COMPATIBILITY_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'about', 'would', 'what',
    'when', 'where', 'which', 'into', 'while', 'there', 'their', 'then', 'than', 'been', 'were',
    'will', 'could', 'should', 'does', 'did', 'are', 'how', 'why', 'can', 'you', 'our', 'but', 'not',
    'just', 'still', 'also', 'make', 'makes', 'made', 'like', 'need', 'want', 'talk', 'lets',
  ]);

  private tokenizeForThreadCompatibility(value: string): string[] {
    return Array.from(new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((token) => {
          if (token.length > 4 && token.endsWith('ies')) {
            return `${token.slice(0, -3)}y`;
          }
          if (token.length > 4 && token.endsWith('s')) {
            return token.slice(0, -1);
          }
          return token;
        })
        .filter((token) => token.length >= 3 && !ConsciousOrchestrator.THREAD_COMPATIBILITY_STOPWORDS.has(token))
    ));
  }

  private hasReferentialFollowUpCue(loweredQuestion: string): boolean {
    return /\b(this|that|it|those|these|them|there|then)\b/.test(loweredQuestion)
      || /^(and|but|so)\b/.test(loweredQuestion)
      || /\b(expand|clarify|explain|unpack|elaborate|deeper)\b/.test(loweredQuestion)
      || /\b(what if|how would that|how does that|why that|why this)\b/.test(loweredQuestion);
  }

  private isShortReferentialFollowUp(loweredQuestion: string): boolean {
    const wordCount = loweredQuestion.split(/\s+/).filter(Boolean).length;
    return wordCount <= 16
      && /^(would|could|can|should|does|do|is|are|was|were|how|why|what)\b/.test(loweredQuestion)
      && /\b(this|that|it|those|these|them)\b/.test(loweredQuestion);
  }

  private isDeterministicContinuationPhrase(loweredQuestion: string): boolean {
    return /^(what are the tradeoffs\??|how would you shard this\??|what happens during failover\??|what metrics would you watch( first)?\??|would that still hold\??)$/i.test(loweredQuestion)
      || /^(why this approach|why this|why not|how so|go deeper|can you go deeper|walk me through that|talk through that|and then|what about reliability|what about scale|what about failure handling|what about bottlenecks)$/i.test(loweredQuestion);
  }

  private isTopicallyCompatibleWithThread(question: string, thread: ReasoningThread): boolean {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      return false;
    }

    const loweredQuestion = normalizedQuestion.toLowerCase();
    if (this.isDeterministicContinuationPhrase(loweredQuestion)) {
      return true;
    }

    const questionTokens = this.tokenizeForThreadCompatibility(normalizedQuestion);
    const referentialFollowUp = this.hasReferentialFollowUpCue(loweredQuestion);

    const threadCorpus = [
      thread.rootQuestion,
      thread.lastQuestion,
      ...thread.response.likelyFollowUps,
      thread.response.behavioralAnswer?.question,
    ].filter(Boolean).join(' ');
    const threadTokens = new Set(this.tokenizeForThreadCompatibility(threadCorpus));

    if (questionTokens.length === 0 || threadTokens.size === 0) {
      return referentialFollowUp;
    }

    let overlapHits = 0;
    for (const token of questionTokens) {
      if (threadTokens.has(token)) {
        overlapHits += 1;
      }
    }

    const overlapRatio = overlapHits / questionTokens.length;
    if (overlapRatio >= 0.25) {
      return true;
    }

    if (overlapHits >= 1 && referentialFollowUp) {
      return true;
    }

    if (overlapHits === 0 && referentialFollowUp && questionTokens.length <= 1 && thread.followUpCount === 0) {
      return true;
    }

    return false;
  }

  private static isValidIntentResult(value: unknown): value is IntentResult {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.intent === 'string'
      && typeof obj.confidence === 'number'
      && typeof obj.answerShape === 'string'
    );
  }

  async prepareRoute(input: {
    question: string;
    knowledgeStatus?: KnowledgeStatusLike | null;
    screenshotBackedLiveCodingTurn: boolean;
    prefetchedIntent?: IntentResult | null;
    transcript?: string;
    assistantResponseCount?: number;
    coordinator?: IntentClassificationCoordinator | null;
    transcriptRevision?: number;
  }): Promise<PreparedConsciousRoute> {
    const currentReasoningThread = this.session.getActiveReasoningThread();
    const latestReaction = this.session.getLatestQuestionReaction();
    const safePrefetchedIntent = ConsciousOrchestrator.isValidIntentResult(input.prefetchedIntent) ? input.prefetchedIntent : null;
    const circuitOpen = this.isCircuitOpen();

    // Layered intent router: prefetched coordinator result first, then the
    // fast SetFit/SLM/embedding/regex ensemble. Reliable model classifiers
    // take authority over regex cues; disabled conscious mode skips this path.
    let intentBasedQualifies = false;
    let routedIntentResult: IntentResult | null = null;

    if (this.session.isConsciousModeEnabled()) {
      if (safePrefetchedIntent && isReliableIntent(safePrefetchedIntent)) {
        intentBasedQualifies = true;
        routedIntentResult = safePrefetchedIntent;
      } else {
        const router = LayeredIntentRouter.getInstance();
        const routerInput = {
          question: input.question,
          transcript: input.transcript ?? '',
          assistantResponseCount: input.assistantResponseCount ?? 0,
          prefetchedIntent: safePrefetchedIntent,
          coordinator: input.coordinator ?? null,
          transcriptRevision: input.transcriptRevision,
        };
        const decision = await router.routeFast(routerInput);
        routedIntentResult = decision.intentResult;
        intentBasedQualifies = decision.isReliable;
      }
    }

    // Regex/thread-based decision for threadAction (handles continuations, topic shifts)
    let preRouteDecision = this.session.isConsciousModeEnabled()
      ? classifyConsciousModeQuestion(input.question, currentReasoningThread)
      : { qualifies: false, threadAction: 'ignore' as const };

    // Intent-based override: if layered router says this is a reliable conscious intent
    // (deep_dive, behavioral, coding, etc.) but regex/thread logic missed it, override.
    // NAT-XXX: Exclude follow_up and clarification — they depend on thread context and
    // regex logic handles them better. Exclude coding without screenshots — live coding
    // should only go conscious when a screenshot is present. Exclude very short questions
    // (< 4 words) — vague pushbacks like "What if?" should not hijack threads.
    const intent = routedIntentResult?.intent;
    const wordCount = input.question.trim().split(/\s+/).filter(Boolean).length;
    const isSubstantialQuestion = wordCount >= 4;
    const canIntentOverride = intentBasedQualifies
      && isSubstantialQuestion
      && intent !== 'follow_up'
      && intent !== 'clarification'
      && (intent !== 'coding' || input.screenshotBackedLiveCodingTurn);

    if (canIntentOverride && !preRouteDecision.qualifies) {
      preRouteDecision = {
        qualifies: true,
        threadAction: currentReasoningThread ? 'reset' : 'start',
      };
    }

    if (latestReaction?.kind === 'topic_shift') {
      preRouteDecision = { qualifies: true, threadAction: 'reset' };
    }

    if (
      preRouteDecision.threadAction === 'continue'
      && currentReasoningThread
      && !this.isTopicallyCompatibleWithThread(input.question, currentReasoningThread)
    ) {
      preRouteDecision = { qualifies: true, threadAction: 'reset' };
    }

    const activeReasoningThread = preRouteDecision.threadAction === 'reset'
      ? null
      : currentReasoningThread;

    // Force standard route if we have a prefetched/intent result that is uncertain
    // (e.g., low-confidence deep_dive) and not a thread continuation.
    const hasReliableIntent = routedIntentResult ? isReliableIntent(routedIntentResult) : false;
    const shouldForceStandardRoute = Boolean(
      routedIntentResult
      && preRouteDecision.threadAction !== 'continue'
      && !hasReliableIntent
      && !circuitOpen
    );

    // When circuit breaker is open, still allow conscious mode via regex-based
    // classification (preRouteDecision.qualifies) — only skip the expensive
    // intent-based path. This prevents the circuit breaker from completely
    // killing conscious mode when the intent router is flaky.
    let selectedRoute = selectAnswerRoute({
      explicitManual: false,
      explicitFollowUp: false,
      consciousModeEnabled: this.session.isConsciousModeEnabled() && !shouldForceStandardRoute,
      profileModeEnabled: !!input.knowledgeStatus?.activeMode,
      hasProfile: !!input.knowledgeStatus?.hasResume,
      hasKnowledgeData: !!input.knowledgeStatus?.hasResume || !!input.knowledgeStatus?.hasActiveJD,
      latestQuestion: input.question,
      activeReasoningThread,
    });

    // Override to conscious_answer if we have a reliable intent and circuit is closed.
    // NAT-XXX: Do not force conscious mode for follow_up / clarification — they rely on
    // thread context. Do not force coding unless screenshots are present. Do not force
    // for very short questions — vague pushbacks should stay on the fast path.
    const canForceConscious = hasReliableIntent
      && !circuitOpen
      && selectedRoute !== 'conscious_answer'
      && isSubstantialQuestion
      && intent !== 'follow_up'
      && intent !== 'clarification'
      && (intent !== 'coding' || input.screenshotBackedLiveCodingTurn);

    if (canForceConscious) {
      selectedRoute = 'conscious_answer';
    }

    const effectiveRoute: AnswerRoute = input.screenshotBackedLiveCodingTurn
      && this.session.isConsciousModeEnabled()
      && !preRouteDecision.qualifies
      ? 'conscious_answer'
      : selectedRoute;

    const standardRouteAfterConsciousFallback = effectiveRoute === 'conscious_answer'
      ? selectAnswerRoute({
          explicitManual: false,
          explicitFollowUp: false,
          consciousModeEnabled: false,
          profileModeEnabled: !!input.knowledgeStatus?.activeMode,
          hasProfile: !!input.knowledgeStatus?.hasResume,
          hasKnowledgeData: !!input.knowledgeStatus?.hasResume || !!input.knowledgeStatus?.hasActiveJD,
          latestQuestion: input.question,
          activeReasoningThread: null,
        })
      : effectiveRoute;

    return {
      preRouteDecision,
      activeReasoningThread,
      selectedRoute,
      effectiveRoute,
      standardRouteAfterConsciousFallback,
    };
  }

  applyRouteSideEffects(route: PreparedConsciousRoute): void {
    if (route.preRouteDecision.threadAction === 'reset') {
      this.session.clearConsciousModeThread();
    }
  }

  private skip(): ConsciousExecutionResult {
    this.consecutiveFailures = 0;
    return { kind: 'skip' };
  }

  async continueThread(input: {
    followUpLLM: FollowUpLLM | null;
    activeReasoningThread: ReasoningThread | null;
    resolvedQuestion: string;
    isStale: () => boolean;
  }): Promise<ConsciousExecutionResult> {
    if (!input.followUpLLM || !input.activeReasoningThread) {
      return this.skip();
    }

    const degradedMode = this.isCircuitOpen();

    try {
      const retrievalPack = this.retrievalOrchestrator.buildPack({
        question: input.resolvedQuestion,
        lastSeconds: 600,
      });
      const evidenceContextBlock = this.session.getConsciousEvidenceContext();

      const structuredResponse = await input.followUpLLM.generateReasoningFirstFollowUp(
        input.activeReasoningThread,
        input.resolvedQuestion,
        [
          this.answerPlanner.buildContextBlock(this.answerPlanner.plan({
            question: input.resolvedQuestion,
            reaction: this.session.getLatestQuestionReaction(),
            hypothesis: this.session.getLatestAnswerHypothesis(),
          })),
          this.session.getConsciousSemanticContext(),
          retrievalPack.combinedContext,
        ].filter(Boolean).join('\n\n')
      );

      if (input.isStale() || !isValidConsciousModeResponse(structuredResponse)) {
        return this.fallback('continuation_invalid_or_stale');
      }

      const latestHypothesis = this.session.getLatestAnswerHypothesis();

      // Always run rule-based provenance — it is fast, deterministic, no network.
      // When degraded mode is active, the LLM judge is skipped but rule-based checks
      // must still run to prevent hallucinations when the system is least healthy.
      const useDegradedProvenanceCheck = isVerifierOptimizationActive('useDegradedProvenanceCheck');
      let provenanceVerdict: { ok: boolean; reason?: string } = { ok: true };
      if (!degradedMode || useDegradedProvenanceCheck) {
        provenanceVerdict = this.provenanceVerifier.verify({
          response: structuredResponse,
          semanticContextBlock: this.session.getConsciousSemanticContext(),
          evidenceContextBlock,
          question: input.resolvedQuestion,
          hypothesis: latestHypothesis,
        });
        if (!provenanceVerdict.ok) {
          console.warn('[ConsciousOrchestrator] Continuation provenance verification failed:', provenanceVerdict.reason);
          if (degradedMode) {
            Metrics.counter('conscious.degraded_provenance_fail', 1);
          }
          return this.fallback(`continuation_provenance:${provenanceVerdict.reason ?? 'unknown'}`);
        }
      }

      const verification = await this.verifier.verify({
        response: structuredResponse,
        route: { qualifies: true, threadAction: 'continue' },
        reaction: this.session.getLatestQuestionReaction(),
        hypothesis: latestHypothesis,
        evidence: latestHypothesis?.evidence,
        question: input.resolvedQuestion,
        skipJudge: degradedMode,
      });
      if (!verification.ok) {
        console.warn('[ConsciousOrchestrator] Continuation verification failed:', verification.reason);
        return this.fallback(`continuation_verification:${verification.reason ?? 'unknown'}`);
      }

      this.session.recordConsciousResponse(input.resolvedQuestion, structuredResponse, 'continue');
      this.recordExecutionSuccess();
      return {
        kind: 'handled',
        structuredResponse,
        fullAnswer: formatConsciousModeResponse(structuredResponse),
        verification: this.buildVerificationMetadata({
          provenanceOk: provenanceVerdict.ok,
          provenanceReason: provenanceVerdict.reason,
          verificationOk: verification.ok,
          verificationReason: verification.reason,
          deterministic: verification.deterministic,
          judge: degradedMode ? 'skipped' : verification.judge,
        }),
      };
    } catch (error) {
      console.warn('[ConsciousOrchestrator] Continuation execution failed:', error);
      return this.fallback('continuation_execution_error');
    }
  }

  async executeReasoningFirst(input: {
    route: ConsciousModeQuestionRoute;
    question: string;
    preparedTranscript: string;
    temporalContext: TemporalContext;
    intentResult: IntentResult;
    imagePaths?: string[];
    whatToAnswerLLM: WhatToAnswerLLM | null;
    answerLLM: AnswerLLM | null;
    onEarlyReasoning?: (text: string) => void;
  }): Promise<ConsciousExecutionResult> {
    if (!input.route.qualifies) {
      return this.skip();
    }

    const degradedMode = this.isCircuitOpen();

    try {
      let structuredResponse: ConsciousModeStructuredResponse | null = null;

      if (input.whatToAnswerLLM) {
        structuredResponse = await input.whatToAnswerLLM!.generateReasoningFirst(
          input.preparedTranscript,
          input.question,
          input.temporalContext,
          input.intentResult,
          input.imagePaths,
          {
            onEarlyReasoning: (text) => {
              // NAT-L4: Emit opening reasoning as a streaming preview
              // so the user sees first content within ~400ms instead of
              // waiting 2-5s for full JSON completion.
              console.log(`[ConsciousOrchestrator] Early reasoning: "${text.substring(0, 60)}..."`);
              input.onEarlyReasoning?.(text);
            },
          }
        );
      } else if (input.answerLLM) {
        structuredResponse = await input.answerLLM.generateReasoningFirst(
          input.question,
          this.session.getFormattedContext(600)
        );
      }

      if (!isValidConsciousModeResponse(structuredResponse)) {
        return this.fallback('reasoning_invalid_response');
      }

      const latestHypothesis = this.session.getLatestAnswerHypothesis();

      // Always run rule-based provenance — it is fast, deterministic, no network.
      // When degraded mode is active, the LLM judge is skipped but rule-based checks
      // must still run to prevent hallucinations when the system is least healthy.
      const useDegradedProvenanceCheck = isVerifierOptimizationActive('useDegradedProvenanceCheck');
      let provenanceVerdict: { ok: boolean; reason?: string } = { ok: true };
      if (!degradedMode || useDegradedProvenanceCheck) {
        provenanceVerdict = this.provenanceVerifier.verify({
          response: structuredResponse,
          semanticContextBlock: this.session.getConsciousSemanticContext(),
          evidenceContextBlock: this.session.getConsciousEvidenceContext(),
          question: input.question,
          hypothesis: latestHypothesis,
        });
        if (!provenanceVerdict.ok) {
          console.warn('[ConsciousOrchestrator] Structured response provenance verification failed:', provenanceVerdict.reason);
          if (degradedMode) {
            Metrics.counter('conscious.degraded_provenance_fail', 1);
          }
          return this.fallback(`reasoning_provenance:${provenanceVerdict.reason ?? 'unknown'}`);
        }
      }

      // In degraded mode, use rule-only verification (skip LLM judge)
      const verification = await this.verifier.verify({
        response: structuredResponse,
        route: input.route,
        reaction: this.session.getLatestQuestionReaction(),
        hypothesis: latestHypothesis,
        evidence: latestHypothesis?.evidence,
        question: input.question,
        skipJudge: degradedMode,
      });
      if (!verification.ok) {
        console.warn('[ConsciousOrchestrator] Structured response verification failed:', verification.reason);
        return this.fallback(`reasoning_verification:${verification.reason ?? 'unknown'}`);
      }

      if (input.route.threadAction !== 'ignore' && input.question) {
        this.session.recordConsciousResponse(
          input.question,
          structuredResponse,
          input.route.threadAction === 'start'
            ? 'start'
            : input.route.threadAction === 'reset'
              ? 'reset'
              : 'continue'
        );
      }

      this.recordExecutionSuccess();
      return {
        kind: 'handled',
        structuredResponse,
        fullAnswer: formatConsciousModeResponse(structuredResponse),
        verification: this.buildVerificationMetadata({
          provenanceOk: provenanceVerdict.ok,
          provenanceReason: provenanceVerdict.reason,
          verificationOk: verification.ok,
          verificationReason: verification.reason,
          deterministic: verification.deterministic,
          judge: degradedMode ? 'skipped' : verification.judge,
        }),
      };
    } catch (error) {
      console.warn('[ConsciousOrchestrator] Reasoning-first execution failed:', error);
      return this.fallback('reasoning_execution_error');
    }
  }
}
