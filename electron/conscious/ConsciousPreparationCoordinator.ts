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
import { sanitizeProfileData } from './ProfileDataSanitizer';
import type { ConsciousModeStructuredResponse, ReasoningThread } from '../ConsciousMode';
import type { QuestionReaction } from './QuestionReactionClassifier';
import type { AnswerHypothesis } from './AnswerHypothesisStore';
import type { ConsciousPlannerPreferenceSummary, ConsciousResponseQuestionMode } from './ConsciousResponsePreferenceStore';
import { detectConsciousQuestionMode } from './ConsciousAnswerPlanner';

interface SessionLike {
  isConsciousModeEnabled(): boolean;
  isLikelyGeneralIntent(lastInterviewerTurn: string | null): boolean;
  getAssistantResponseHistory(): AssistantResponse[];
  getConsciousEvidenceContext(): string;
  getConsciousLongMemoryContext(question: string): string;
  setConsciousSemanticContext(block: string): void;
  getFormattedContext(lastSeconds: number): string;
  getActiveReasoningThread(): ReasoningThread | null;
  getLatestConsciousResponse(): ConsciousModeStructuredResponse | null;
  getLatestQuestionReaction(): QuestionReaction | null;
  getLatestAnswerHypothesis(): AnswerHypothesis | null;
  getConsciousResponsePreferenceContext(questionMode: ConsciousResponseQuestionMode): string;
  getConsciousResponsePreferenceSummary(questionMode: ConsciousResponseQuestionMode): ConsciousPlannerPreferenceSummary;
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
    getConsciousRelevantContext: (query: string, tokenBudget: number) => Promise<ContextItem[]>;
    tokenBudget: number;
    transcriptTurnLimit: number;
    temporalWindowSeconds: number;
    profileData?: any;
    hardBudgetMs: number;
    contextAssemblyStart?: number;
    classifyIntent: (
      lastInterviewerTurn: string | null,
      preparedTranscript: string,
      assistantResponseCount: number,
    ) => Promise<IntentResult>;
    onInterimInjected?: (text: string) => void;
  }): Promise<ConsciousPreparationResult> {
    let contextItems = input.contextItems;
    if (input.resolvedQuestion && this.session.isConsciousModeEnabled()) {
      try {
        if (input.useConsciousAcceleration) {
          const assembledContext = await input.getAssembledContext(input.resolvedQuestion, input.tokenBudget);
          contextItems = assembledContext.contextItems;
        } else {
          contextItems = await input.getConsciousRelevantContext(input.resolvedQuestion, input.tokenBudget);
        }
      } catch (error) {
        console.warn('[ConsciousPreparation] Context retrieval failed, using fallback context items:', error);
      }
    }

    const contextAssemblyStart = input.contextAssemblyStart ?? Date.now();
    const sanitizedProfile = sanitizeProfileData(input.profileData);
    if (sanitizedProfile.warnings.length > 0) {
      console.warn('[ConsciousPreparation] Profile data sanitized before prompt use:', {
        warnings: sanitizedProfile.warnings,
        truncatedFields: sanitizedProfile.truncatedFields,
        removedInjectionFields: sanitizedProfile.removedInjectionFields,
      });
    }
    this.semanticFactStore.seedFromProfileData(sanitizedProfile.data);
    if (!input.profileData && this.session.isConsciousModeEnabled()) {
      console.warn('[ConsciousPreparation] No profile data available for semantic fact enrichment. Conscious mode responses will lack personalized context.');
    }
    const stateBlock = this.retrievalOrchestrator.buildStateBlock(
      input.lastInterviewerTurn || input.resolvedQuestion,
    );
    const liveRagBlock = this.retrievalOrchestrator.buildLiveRagBlock({
      question: input.lastInterviewerTurn || input.resolvedQuestion,
      contextItems,
      maxItems: 6,
    });
    const longMemoryBlock = this.session.getConsciousLongMemoryContext(
      input.lastInterviewerTurn || input.resolvedQuestion
    );
    const planningQuestion = input.lastInterviewerTurn || input.resolvedQuestion;
    const questionMode = detectConsciousQuestionMode(planningQuestion);
    const preferenceSummary = this.session.getConsciousResponsePreferenceSummary(questionMode);
    const answerPlan = this.answerPlanner.plan({
      question: planningQuestion,
      reaction: this.session.getLatestQuestionReaction(),
      hypothesis: this.session.getLatestAnswerHypothesis(),
      preferenceSummary,
    });
    const preferenceBlock = this.session.getConsciousResponsePreferenceContext(answerPlan.questionMode);
    const planBlock = this.answerPlanner.buildContextBlock(answerPlan);
    const semanticBlock = this.semanticFactStore.buildContextBlock({
      question: input.lastInterviewerTurn || input.resolvedQuestion,
      reaction: this.session.getLatestQuestionReaction(),
      limit: 5,
    });
    this.session.setConsciousSemanticContext(semanticBlock);
    const evidenceBlocks = [
      preferenceBlock,
      planBlock,
      semanticBlock,
      stateBlock,
      liveRagBlock,
      longMemoryBlock,
      this.session.getConsciousEvidenceContext(),
    ].filter(Boolean);
    const SOFT_TOKEN_BUDGET = Math.floor(input.tokenBudget * 0.6);
    const estimatedEvidenceTokens = evidenceBlocks.join(' ').split(/\s+/).length;
    let evidenceContextBlock: string;
    if (estimatedEvidenceTokens > SOFT_TOKEN_BUDGET) {
      const trimmed = evidenceBlocks
        .map(block => block.split(/\s+/).slice(0, Math.floor(SOFT_TOKEN_BUDGET / evidenceBlocks.length)).join(' '))
        .filter(Boolean);
      console.warn(`[ConsciousPreparation] Evidence context exceeded soft token budget (${estimatedEvidenceTokens} > ${SOFT_TOKEN_BUDGET}). Trimming blocks proportionally.`);
      evidenceContextBlock = trimmed.join('\n\n');
    } else {
      evidenceContextBlock = evidenceBlocks.join('\n\n');
    }

    const composedContext = this.consciousContextComposer.compose({
      contextItems,
      lastInterim: input.lastInterim,
      assistantHistory: this.session.getAssistantResponseHistory(),
      evidenceContextBlock,
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
