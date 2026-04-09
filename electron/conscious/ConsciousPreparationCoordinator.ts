import type { AssistantResponse } from '../llm/TemporalContextBuilder';
import type { IntentResult } from '../llm/IntentClassifier';
import type { AnswerRoute } from '../latency/AnswerLatencyTracker';
import type { ContextItem, TranscriptSegment } from '../SessionTracker';
import type { PreparedConsciousRoute } from './ConsciousOrchestrator';
import { ConsciousAnswerPlanner, type ConsciousAnswerPlan } from './ConsciousAnswerPlanner';
import { ConsciousContextComposer } from './ConsciousContextComposer';
import { ConsciousIntentService, type ResolvedIntentResult } from './ConsciousIntentService';
import { ConsciousOrchestrator } from './ConsciousOrchestrator';
import { ConsciousRetrievalOrchestrator } from './ConsciousRetrievalOrchestrator';
import { ConsciousSemanticFactStore } from './ConsciousSemanticFactStore';
import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { QuestionReaction } from './QuestionReactionClassifier';
import type { AnswerHypothesis } from './AnswerHypothesisStore';

interface SessionLike {
  isConsciousModeEnabled(): boolean;
  isLikelyGeneralIntent(lastInterviewerTurn: string | null): boolean;
  getAssistantResponseHistory(): AssistantResponse[];
  getConsciousEvidenceContext(): string;
  setConsciousSemanticContext(block: string): void;
  getFormattedContext(lastSeconds: number): string;
  getActiveReasoningThread(): ReasoningThread | null;
  getLatestConsciousResponse(): ConsciousModeStructuredResponse | null;
  getLatestQuestionReaction(): QuestionReaction | null;
  getLatestAnswerHypothesis(): AnswerHypothesis | null;
}

interface KnowledgeStatusLike {
  activeMode?: unknown;
  hasResume?: unknown;
  hasActiveJD?: unknown;
}

export interface ConsciousPreparationResult {
  contextItems: ContextItem[];
  preparedTranscript: string;
  temporalContext: ReturnType<ConsciousContextComposer['compose']>['temporalContext'];
  intentResult: ResolvedIntentResult;
  answerPlan: ConsciousAnswerPlan;
  totalContextAssemblyMs: number;
  timedOut: boolean;
}

export interface ConsciousRoutePreparationResult {
  preparedRoute: PreparedConsciousRoute;
}

export class ConsciousPreparationCoordinator {
  private readonly retrievalOrchestrator: ConsciousRetrievalOrchestrator;
  private readonly answerPlanner: ConsciousAnswerPlanner;
  private readonly semanticFactStore: ConsciousSemanticFactStore;

  constructor(
    private readonly session: SessionLike,
    private readonly consciousOrchestrator: ConsciousOrchestrator,
    private readonly consciousContextComposer: ConsciousContextComposer,
    private readonly consciousIntentService: ConsciousIntentService,
  ) {
    this.retrievalOrchestrator = new ConsciousRetrievalOrchestrator(this.session);
    this.answerPlanner = new ConsciousAnswerPlanner();
    this.semanticFactStore = new ConsciousSemanticFactStore();
  }

  prepareRoute(input: {
    baseQuestion: string;
    knowledgeStatus?: KnowledgeStatusLike | null;
    screenshotBackedLiveCodingTurn: boolean;
  }): ConsciousRoutePreparationResult {
    const shouldUseScreenshotConsciousRoute = this.session.isConsciousModeEnabled()
      && !this.consciousOrchestrator.prepareRoute({
        question: input.baseQuestion,
        knowledgeStatus: input.knowledgeStatus,
        screenshotBackedLiveCodingTurn: false,
      }).preRouteDecision.qualifies
      && input.screenshotBackedLiveCodingTurn;

    return {
      preparedRoute: this.consciousOrchestrator.prepareRoute({
        question: input.baseQuestion,
        knowledgeStatus: input.knowledgeStatus,
        screenshotBackedLiveCodingTurn: shouldUseScreenshotConsciousRoute,
      }),
    };
  }

  async prepareReasoningContext(input: {
    resolvedQuestion: string;
    contextItems: ContextItem[];
    lastInterim: TranscriptSegment | null;
    lastInterviewerTurn: string | null;
    useConsciousAcceleration: boolean;
    getAssembledContext: (query: string, tokenBudget: number) => Promise<{ contextItems: ContextItem[] }>;
    tokenBudget: number;
    transcriptTurnLimit: number;
    temporalWindowSeconds: number;
    profileData?: any;
    hardBudgetMs: number;
    classifyIntent: (
      lastInterviewerTurn: string | null,
      preparedTranscript: string,
      assistantResponseCount: number,
    ) => Promise<IntentResult>;
    onInterimInjected?: (text: string) => void;
  }): Promise<ConsciousPreparationResult> {
    let contextItems = input.contextItems;
    if (input.useConsciousAcceleration && input.resolvedQuestion) {
      const assembledContext = await input.getAssembledContext(input.resolvedQuestion, input.tokenBudget);
      contextItems = assembledContext.contextItems;
    }

    const contextAssemblyStart = Date.now();
    this.semanticFactStore.seedFromProfileData(input.profileData);
    const retrievalPack = this.retrievalOrchestrator.buildPack({
      question: input.lastInterviewerTurn || input.resolvedQuestion,
      lastSeconds: input.temporalWindowSeconds,
    });
    const answerPlan = this.answerPlanner.plan({
      question: input.lastInterviewerTurn || input.resolvedQuestion,
      reaction: this.session.getLatestQuestionReaction(),
      hypothesis: this.session.getLatestAnswerHypothesis(),
    });
    const planBlock = this.answerPlanner.buildContextBlock(answerPlan);
    const semanticBlock = this.semanticFactStore.buildContextBlock({
      question: input.lastInterviewerTurn || input.resolvedQuestion,
      reaction: this.session.getLatestQuestionReaction(),
      limit: 5,
    });
    this.session.setConsciousSemanticContext(semanticBlock);
    const composedContext = this.consciousContextComposer.compose({
      contextItems,
      lastInterim: input.lastInterim,
      assistantHistory: this.session.getAssistantResponseHistory(),
      evidenceContextBlock: [planBlock, semanticBlock, retrievalPack.stateBlock, this.session.getConsciousEvidenceContext()].filter(Boolean).join('\n\n'),
      transcriptTurnLimit: input.transcriptTurnLimit,
      temporalWindowSeconds: input.temporalWindowSeconds,
      onInterimInjected: input.onInterimInjected,
    });

    const { intentResult, totalContextAssemblyMs, timedOut } = await this.consciousIntentService.resolve({
      lastInterviewerTurn: input.lastInterviewerTurn,
      preparedTranscript: composedContext.preparedTranscript,
      assistantResponseCount: this.session.getAssistantResponseHistory().length,
      startedAt: contextAssemblyStart,
      hardBudgetMs: input.hardBudgetMs,
      isLikelyGeneralIntent: this.session.isLikelyGeneralIntent(input.lastInterviewerTurn),
      classifyIntent: input.classifyIntent,
    });

    return {
      contextItems: composedContext.contextItems,
      preparedTranscript: composedContext.preparedTranscript,
      temporalContext: composedContext.temporalContext,
      intentResult,
      answerPlan,
      totalContextAssemblyMs,
      timedOut,
    };
  }
}
