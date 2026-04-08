import {
  classifyConsciousModeQuestion,
  formatConsciousModeResponse,
  isValidConsciousModeResponse,
  type ConsciousModeQuestionRoute,
  type ConsciousModeStructuredResponse,
  type ReasoningThread,
} from '../ConsciousMode';
import type { TemporalContext } from '../llm/TemporalContextBuilder';
import type { IntentResult } from '../llm/IntentClassifier';
import type { WhatToAnswerLLM } from '../llm/WhatToAnswerLLM';
import type { AnswerLLM } from '../llm/AnswerLLM';
import type { FollowUpLLM } from '../llm/FollowUpLLM';
import { selectAnswerRoute } from '../latency/answerRouteSelector';
import type { AnswerRoute } from '../latency/AnswerLatencyTracker';

interface KnowledgeStatusLike {
  activeMode?: unknown;
  hasResume?: unknown;
  hasActiveJD?: unknown;
}

interface ConsciousSession {
  isConsciousModeEnabled(): boolean;
  getActiveReasoningThread(): ReasoningThread | null;
  clearConsciousModeThread(): void;
  getFormattedContext(lastSeconds: number): string;
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
  constructor(private readonly session: ConsciousSession) {}

  prepareRoute(input: {
    question: string;
    knowledgeStatus?: KnowledgeStatusLike | null;
    screenshotBackedLiveCodingTurn: boolean;
  }): PreparedConsciousRoute {
    const currentReasoningThread = this.session.getActiveReasoningThread();
    const preRouteDecision = this.session.isConsciousModeEnabled()
      ? classifyConsciousModeQuestion(input.question, currentReasoningThread)
      : { qualifies: false, threadAction: 'ignore' as const };

    const activeReasoningThread = preRouteDecision.threadAction === 'reset'
      ? null
      : currentReasoningThread;

    if (preRouteDecision.threadAction === 'reset') {
      this.session.clearConsciousModeThread();
    }

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

  async continueThread(input: {
    followUpLLM: FollowUpLLM | null;
    activeReasoningThread: ReasoningThread | null;
    resolvedQuestion: string;
    isStale: () => boolean;
  }): Promise<ConsciousExecutionResult> {
    if (!input.followUpLLM || !input.activeReasoningThread) {
      return { kind: 'skip' };
    }

    const structuredResponse = await input.followUpLLM.generateReasoningFirstFollowUp(
      input.activeReasoningThread,
      input.resolvedQuestion,
      this.session.getFormattedContext(180)
    );

    if (input.isStale() || !isValidConsciousModeResponse(structuredResponse)) {
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
