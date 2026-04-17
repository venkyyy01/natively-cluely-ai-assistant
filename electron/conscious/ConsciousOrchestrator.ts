import {
  classifyConsciousModeQuestion,
  formatConsciousModeResponse,
  isValidConsciousModeResponse,
  type ConsciousModeQuestionRoute,
  type ConsciousModeStructuredResponse,
  type ReasoningThread,
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
import { ConsciousProvenanceVerifier } from './ConsciousProvenanceVerifier';
import { ConsciousVerifier } from './ConsciousVerifier';

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
  | { kind: 'handled'; structuredResponse: ConsciousModeStructuredResponse; fullAnswer: string };

export class ConsciousOrchestrator {
  private readonly verifier = new ConsciousVerifier();
  private readonly retrievalOrchestrator: ConsciousRetrievalOrchestrator;
  private readonly answerPlanner = new ConsciousAnswerPlanner();
  private readonly provenanceVerifier = new ConsciousProvenanceVerifier();

  constructor(private readonly session: ConsciousSession, verifier?: ConsciousVerifier) {
    if (verifier) {
      this.verifier = verifier;
    }
    this.retrievalOrchestrator = new ConsciousRetrievalOrchestrator(this.session);
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
    return /^(what are the tradeoffs\??|how would you shard this\??|what happens during failover\??|what metrics would you watch( first)?\??)$/i.test(loweredQuestion)
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
      thread.response.openingReasoning,
      ...thread.response.implementationPlan,
      ...thread.response.tradeoffs,
      ...thread.response.edgeCases,
      ...thread.response.scaleConsiderations,
      ...thread.response.pushbackResponses,
      ...thread.response.likelyFollowUps,
      thread.response.codeTransition,
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

    if (overlapHits === 0 && this.isShortReferentialFollowUp(loweredQuestion)) {
      return true;
    }

    if (overlapHits === 0 && referentialFollowUp && questionTokens.length <= 1) {
      return true;
    }

    return false;
  }

  prepareRoute(input: {
    question: string;
    knowledgeStatus?: KnowledgeStatusLike | null;
    screenshotBackedLiveCodingTurn: boolean;
  }): PreparedConsciousRoute {
    const currentReasoningThread = this.session.getActiveReasoningThread();
    const latestReaction = this.session.getLatestQuestionReaction();
    let preRouteDecision = this.session.isConsciousModeEnabled()
      ? classifyConsciousModeQuestion(input.question, currentReasoningThread)
      : { qualifies: false, threadAction: 'ignore' as const };

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

    const selectedRoute = selectAnswerRoute({
      explicitManual: false,
      explicitFollowUp: false,
      consciousModeEnabled: this.session.isConsciousModeEnabled(),
      profileModeEnabled: !!input.knowledgeStatus?.activeMode,
      hasProfile: !!input.knowledgeStatus?.hasResume,
      hasKnowledgeData: !!input.knowledgeStatus?.hasResume || !!input.knowledgeStatus?.hasActiveJD,
      latestQuestion: input.question,
      activeReasoningThread,
    });

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

  async continueThread(input: {
    followUpLLM: FollowUpLLM | null;
    activeReasoningThread: ReasoningThread | null;
    resolvedQuestion: string;
    isStale: () => boolean;
  }): Promise<ConsciousExecutionResult> {
    if (!input.followUpLLM || !input.activeReasoningThread) {
      return { kind: 'skip' };
    }

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
      return { kind: 'fallback' };
    }

    const provenanceVerdict = this.provenanceVerifier.verify({
      response: structuredResponse,
      semanticContextBlock: this.session.getConsciousSemanticContext(),
      evidenceContextBlock,
      question: input.resolvedQuestion,
      hypothesis: this.session.getLatestAnswerHypothesis(),
    });
    if (!provenanceVerdict.ok) {
      console.warn('[ConsciousOrchestrator] Continuation provenance verification failed:', provenanceVerdict.reason);
      return { kind: 'fallback' };
    }
    const verification = await this.verifier.verify({
      response: structuredResponse,
      route: { qualifies: true, threadAction: 'continue' },
      reaction: this.session.getLatestQuestionReaction(),
      hypothesis: this.session.getLatestAnswerHypothesis(),
      question: input.resolvedQuestion,
    });
    if (!verification.ok) {
      console.warn('[ConsciousOrchestrator] Continuation verification failed:', verification.reason);
      return { kind: 'fallback' };
    }

    this.session.recordConsciousResponse(input.resolvedQuestion, structuredResponse, 'continue');
    return {
      kind: 'handled',
      structuredResponse,
      fullAnswer: formatConsciousModeResponse(structuredResponse),
    };
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
  }): Promise<ConsciousExecutionResult> {
    if (!input.route.qualifies) {
      return { kind: 'skip' };
    }

    let structuredResponse: ConsciousModeStructuredResponse | null = null;

    if (input.whatToAnswerLLM) {
      structuredResponse = await input.whatToAnswerLLM.generateReasoningFirst(
        input.preparedTranscript,
        input.question,
        input.temporalContext,
        input.intentResult,
        input.imagePaths
      );
    } else if (input.answerLLM) {
      structuredResponse = await input.answerLLM.generateReasoningFirst(
        input.question,
        this.session.getFormattedContext(600)
      );
    }

    if (!isValidConsciousModeResponse(structuredResponse)) {
      return { kind: 'fallback' };
    }

    const provenanceVerdict = this.provenanceVerifier.verify({
      response: structuredResponse,
      semanticContextBlock: this.session.getConsciousSemanticContext(),
      evidenceContextBlock: this.session.getConsciousEvidenceContext(),
      question: input.question,
      hypothesis: this.session.getLatestAnswerHypothesis(),
    });
    if (!provenanceVerdict.ok) {
      console.warn('[ConsciousOrchestrator] Structured response provenance verification failed:', provenanceVerdict.reason);
      return { kind: 'fallback' };
    }
    const verification = await this.verifier.verify({
      response: structuredResponse,
      route: input.route,
      reaction: this.session.getLatestQuestionReaction(),
      hypothesis: this.session.getLatestAnswerHypothesis(),
      question: input.question,
    });
    if (!verification.ok) {
      console.warn('[ConsciousOrchestrator] Structured response verification failed:', verification.reason);
      return { kind: 'fallback' };
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

    return {
      kind: 'handled',
      structuredResponse,
      fullAnswer: formatConsciousModeResponse(structuredResponse),
    };
  }
}
