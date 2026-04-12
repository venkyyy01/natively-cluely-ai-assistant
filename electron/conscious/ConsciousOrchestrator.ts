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

    if (currentReasoningThread && latestReaction?.shouldContinueThread && preRouteDecision.threadAction === 'start') {
      preRouteDecision = { qualifies: true, threadAction: 'continue' };
    }

    if (latestReaction?.kind === 'topic_shift') {
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
      lastSeconds: 180,
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
        this.session.getFormattedContext(180)
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
