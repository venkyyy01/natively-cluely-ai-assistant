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
import type { CoordinatedIntentResult } from '../llm/providers/IntentClassificationCoordinator';

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
  prefetchedIntentUsed: boolean;
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

  private buildEvidenceContextBlock(input: {
    answerPlan: ConsciousAnswerPlan;
    stateBlock: string;
    liveRagBlock: string;
    longMemoryBlock: string;
    semanticBlock: string;
    tokenBudget: number;
  }): string {
    const preferenceBlock = this.session.getConsciousResponsePreferenceContext(input.answerPlan.questionMode);
    const planBlock = this.answerPlanner.buildContextBlock(input.answerPlan);
    const evidenceBlocks = [
      preferenceBlock,
      planBlock,
      input.semanticBlock,
      input.stateBlock,
      input.liveRagBlock,
      input.longMemoryBlock,
      this.session.getConsciousEvidenceContext(),
    ].filter(Boolean);
    const softTokenBudget = Math.floor(input.tokenBudget * 0.6);
    const estimatedEvidenceTokens = evidenceBlocks.join(' ').split(/\s+/).length;

    if (estimatedEvidenceTokens <= softTokenBudget) {
      return evidenceBlocks.join('\n\n');
    }

    const trimmed = evidenceBlocks
      .map((block) => block.split(/\s+/).slice(0, Math.floor(softTokenBudget / evidenceBlocks.length)).join(' '))
      .filter(Boolean);
    console.warn(`[ConsciousPreparation] Evidence context exceeded soft token budget (${estimatedEvidenceTokens} > ${softTokenBudget}). Trimming blocks proportionally.`);
    return trimmed.join('\n\n');
  }

  private shouldRebuildPreparedTranscript(currentPlan: ConsciousAnswerPlan, nextPlan: ConsciousAnswerPlan): boolean {
    return currentPlan.questionMode !== nextPlan.questionMode
      || currentPlan.answerShape !== nextPlan.answerShape
      || currentPlan.deliveryFormat !== nextPlan.deliveryFormat
      || currentPlan.deliveryStyle !== nextPlan.deliveryStyle
      || currentPlan.maxWords !== nextPlan.maxWords
      || currentPlan.groundingHint !== nextPlan.groundingHint
      || currentPlan.focalFacets.join('|') !== nextPlan.focalFacets.join('|');
  }

  prepareRoute(input: {
    baseQuestion: string;
    knowledgeStatus?: KnowledgeStatusLike | null;
    screenshotBackedLiveCodingTurn: boolean;
    prefetchedIntent?: CoordinatedIntentResult | null;
  }): ConsciousRoutePreparationResult {
    const shouldUseScreenshotConsciousRoute = this.session.isConsciousModeEnabled()
      && !this.consciousOrchestrator.prepareRoute({
        question: input.baseQuestion,
        knowledgeStatus: input.knowledgeStatus,
        screenshotBackedLiveCodingTurn: false,
        prefetchedIntent: input.prefetchedIntent ?? null,
      }).preRouteDecision.qualifies
      && input.screenshotBackedLiveCodingTurn;

    return {
      preparedRoute: this.consciousOrchestrator.prepareRoute({
        question: input.baseQuestion,
        knowledgeStatus: input.knowledgeStatus,
        screenshotBackedLiveCodingTurn: shouldUseScreenshotConsciousRoute,
        prefetchedIntent: input.prefetchedIntent ?? null,
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
    prefetchedIntent?: CoordinatedIntentResult | null;
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
    const reaction = this.session.getLatestQuestionReaction();
    const hypothesis = this.session.getLatestAnswerHypothesis();
    let preferenceSummary = this.session.getConsciousResponsePreferenceSummary(detectConsciousQuestionMode(planningQuestion));
    let answerPlan = this.answerPlanner.plan({
      question: planningQuestion,
      reaction,
      hypothesis,
      preferenceSummary,
      intentResult: input.prefetchedIntent ?? null,
    });
    if (answerPlan.questionMode !== detectConsciousQuestionMode(planningQuestion)) {
      preferenceSummary = this.session.getConsciousResponsePreferenceSummary(answerPlan.questionMode);
      answerPlan = this.answerPlanner.plan({
        question: planningQuestion,
        reaction,
        hypothesis,
        preferenceSummary,
        intentResult: input.prefetchedIntent ?? null,
      });
    }
    const semanticBlock = this.semanticFactStore.buildContextBlock({
      question: input.lastInterviewerTurn || input.resolvedQuestion,
      reaction,
      limit: 5,
    });
    this.session.setConsciousSemanticContext(semanticBlock);
    let evidenceContextBlock = this.buildEvidenceContextBlock({
      answerPlan,
      stateBlock,
      liveRagBlock,
      longMemoryBlock,
      semanticBlock,
      tokenBudget: input.tokenBudget,
    });

    let composedContext = this.consciousContextComposer.compose({
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
      prefetchedIntent: input.prefetchedIntent ?? null,
    });

    let resolvedPreferenceSummary = this.session.getConsciousResponsePreferenceSummary(answerPlan.questionMode);
    let resolvedAnswerPlan = this.answerPlanner.plan({
      question: planningQuestion,
      reaction,
      hypothesis,
      preferenceSummary: resolvedPreferenceSummary,
      intentResult,
    });
    if (resolvedAnswerPlan.questionMode !== answerPlan.questionMode) {
      resolvedPreferenceSummary = this.session.getConsciousResponsePreferenceSummary(resolvedAnswerPlan.questionMode);
      resolvedAnswerPlan = this.answerPlanner.plan({
        question: planningQuestion,
        reaction,
        hypothesis,
        preferenceSummary: resolvedPreferenceSummary,
        intentResult,
      });
    }
    if (this.shouldRebuildPreparedTranscript(answerPlan, resolvedAnswerPlan)) {
      answerPlan = resolvedAnswerPlan;
      evidenceContextBlock = this.buildEvidenceContextBlock({
        answerPlan,
        stateBlock,
        liveRagBlock,
        longMemoryBlock,
        semanticBlock,
        tokenBudget: input.tokenBudget,
      });
      composedContext = this.consciousContextComposer.compose({
        contextItems,
        lastInterim: input.lastInterim,
        assistantHistory: this.session.getAssistantResponseHistory(),
        evidenceContextBlock,
        transcriptTurnLimit: input.transcriptTurnLimit,
        temporalWindowSeconds: input.temporalWindowSeconds,
        onInterimInjected: input.onInterimInjected,
      });
    } else {
      answerPlan = resolvedAnswerPlan;
    }

    return {
      contextItems: composedContext.contextItems,
      preparedTranscript: composedContext.preparedTranscript,
      temporalContext: composedContext.temporalContext,
      intentResult,
      answerPlan,
      totalContextAssemblyMs,
      timedOut,
      prefetchedIntentUsed: Boolean(input.prefetchedIntent),
    };
  }
}
