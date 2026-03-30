// IntelligenceEngine.ts
// LLM mode routing and orchestration.
// Extracted from IntelligenceManager to decouple LLM logic from state management.

import { EventEmitter } from 'events';
import { LLMHelper } from './LLMHelper';
import { SessionTracker, TranscriptSegment, SuggestionTrigger, ContextItem } from './SessionTracker';
import {
  classifyConsciousModeQuestion,
  formatConsciousModeResponse,
  isValidConsciousModeResponse,
} from './ConsciousMode';
import {
  AnswerLLM, AssistLLM, FollowUpLLM, RecapLLM,
  FollowUpQuestionsLLM, WhatToAnswerLLM,
  prepareTranscriptForWhatToAnswer, buildTemporalContext,
  AssistantResponse as LLMAssistantResponse, classifyIntent
} from './llm';
import { FallbackExecutor } from './conscious';
import { ParallelContextAssembler, ContextAssemblyInput, ContextAssemblyOutput } from './cache/ParallelContextAssembler';
import { isOptimizationActive } from './config/optimizations';
import { AnswerLatencyTracker, AnswerRoute } from './latency/AnswerLatencyTracker';
import { selectAnswerRoute } from './latency/answerRouteSelector';

// Mode types
export type IntelligenceMode = 'idle' | 'assist' | 'what_to_say' | 'follow_up' | 'recap' | 'manual' | 'follow_up_questions' | 'reasoning_first';

const PROFILE_ENRICHMENT_TIMEOUT_MS = 250;

// Refinement intent detection (refined to avoid false positives)
function detectRefinementIntent(userText: string): { isRefinement: boolean; intent: string } {
    const lowercased = userText.toLowerCase().trim();
    const refinementPatterns = [
        { pattern: /make it shorter|shorten this|be brief/i, intent: 'shorten' },
        { pattern: /make it longer|expand on this|elaborate more/i, intent: 'expand' },
        { pattern: /rephrase that|say it differently|put it another way/i, intent: 'rephrase' },
        { pattern: /give me an example|provide an instance/i, intent: 'add_example' },
        { pattern: /make it more confident|be more assertive|sound stronger/i, intent: 'more_confident' },
        { pattern: /make it casual|be less formal|sound relaxed/i, intent: 'more_casual' },
        { pattern: /make it formal|be more professional|sound professional/i, intent: 'more_formal' },
        { pattern: /simplify this|make it simpler|explain specifically/i, intent: 'simplify' },
    ];

    for (const { pattern, intent } of refinementPatterns) {
        if (pattern.test(lowercased)) {
            return { isRefinement: true, intent };
        }
    }

    return { isRefinement: false, intent: '' };
}

// Events emitted by IntelligenceEngine
export interface IntelligenceModeEvents {
    'assist_update': (insight: string) => void;
    'suggested_answer': (answer: string, question: string, confidence: number) => void;
    'suggested_answer_token': (token: string, question: string, confidence: number) => void;
    'refined_answer': (answer: string, intent: string) => void;
    'refined_answer_token': (token: string, intent: string) => void;
    'recap': (summary: string) => void;
    'recap_token': (token: string) => void;
    'follow_up_questions_update': (questions: string) => void;
    'follow_up_questions_token': (token: string) => void;
    'manual_answer_started': () => void;
    'manual_answer_result': (answer: string, question: string) => void;
    'mode_changed': (mode: IntelligenceMode) => void;
    'error': (error: Error, mode: IntelligenceMode) => void;
}

export class IntelligenceEngine extends EventEmitter {
  // Mode state
  private activeMode: IntelligenceMode = 'idle';
  private assistCancellationToken: AbortController | null = null;

  // Mode-specific LLMs
  private answerLLM: AnswerLLM | null = null;
  private assistLLM: AssistLLM | null = null;
  private followUpLLM: FollowUpLLM | null = null;
  private recapLLM: RecapLLM | null = null;
  private followUpQuestionsLLM: FollowUpQuestionsLLM | null = null;
  private whatToAnswerLLM: WhatToAnswerLLM | null = null;

  // Keep reference to LLMHelper for client access
  private llmHelper: LLMHelper;

  // Reference to SessionTracker for context
  private session: SessionTracker;

  // Conscious Mode Realtime fallback executor
  private fallbackExecutor: FallbackExecutor = new FallbackExecutor();

  // Parallel context assembler for acceleration
  private parallelContextAssembler: ParallelContextAssembler | null = null;
  private latencyTracker: AnswerLatencyTracker = new AnswerLatencyTracker();
  private activeWhatToSayRequestId = 0;

  // Timestamps for tracking
  private lastTranscriptTime: number = 0;
  private lastTriggerTime: number = 0;
  private readonly triggerCooldown: number = 3000; // 3 seconds

  constructor(llmHelper: LLMHelper, session: SessionTracker) {
    super();
    this.llmHelper = llmHelper;
    this.session = session;
    this.initializeLLMs();
    
    if (isOptimizationActive('useParallelContext')) {
      this.parallelContextAssembler = new ParallelContextAssembler({});
    }
  }

  protected async classifyIntentForRoute(
    lastInterviewerTurn: string | null,
    preparedTranscript: string,
    assistantResponseCount: number,
  ) {
    return classifyIntent(lastInterviewerTurn, preparedTranscript, assistantResponseCount);
  }

  private async getAssembledContext(query: string, tokenBudget: number): Promise<{
    contextItems: ContextItem[];
    assemblyResult?: ContextAssemblyOutput;
  }> {
    const contextItems = this.session.getContext(tokenBudget);
    
    if (!this.parallelContextAssembler || !isOptimizationActive('useParallelContext')) {
      return { contextItems };
    }

    const transcript = contextItems.map(item => ({
      speaker: item.role,
      text: item.text,
      timestamp: item.timestamp,
    }));

    const input: ContextAssemblyInput = {
      query,
      transcript,
      previousContext: {
        recentTopics: [],
        activeThread: null,
      },
    };

    try {
      const assemblyResult = await this.parallelContextAssembler.assemble(input);
      
      const relevantItems = assemblyResult.relevantContext.map(ctx => ({
        role: 'interviewer' as const,
        text: ctx.text,
        timestamp: ctx.timestamp,
      }));

      return {
        contextItems: relevantItems.length > 0 ? relevantItems : contextItems,
        assemblyResult,
      };
    } catch (error) {
      console.warn('[IntelligenceEngine] ParallelContextAssembler failed, using fallback:', error);
      return { contextItems };
    }
  }

  getLLMHelper(): LLMHelper {
        return this.llmHelper;
    }

    setSession(session: SessionTracker): void {
        this.session = session;
        if (this.recapLLM) {
            this.session.setRecapLLM(this.recapLLM);
        }
    }

    private buildCompactTranscriptSnapshot(
        transcriptTurns: Array<{ role: string; text: string; timestamp: number }>,
        maxTurns: number = 12,
    ): string {
        return transcriptTurns.slice(-maxTurns).map(item => {
            const label = item.role === 'interviewer' ? 'INTERVIEWER' : item.role === 'assistant' ? 'ASSISTANT' : 'ME';
            return `[${label}]: ${item.text}`;
        }).join('\n');
    }

    private buildFastStandardTranscriptContext(latestQuestion: string, latestAssistantMessage: string | null): string {
        const turns: string[] = [];

        if (latestAssistantMessage?.trim()) {
            turns.push(`[ASSISTANT]: ${latestAssistantMessage.trim()}`);
        }

        if (latestQuestion.trim()) {
            turns.push(`[INTERVIEWER]: ${latestQuestion.trim()}`);
        }

        return turns.join('\n');
    }

    private hasUsableProfileGrounding(result: {
        systemPromptInjection?: string;
        contextBlock?: string;
        isIntroQuestion?: boolean;
        introResponse?: string;
    } | null | undefined): boolean {
        if (!result) {
            return false;
        }

        if (result.isIntroQuestion && result.introResponse?.trim()) {
            return true;
        }

        return !!result.contextBlock?.trim() || !!result.systemPromptInjection?.trim();
    }

    private isLiveCodingQuestion(question: string): boolean {
        return /(write|implement|debug|fix|refactor|code|function|typescript|javascript|python|java|bug)/i.test(question);
    }

    private isScreenshotBackedLiveCodingTurn(question: string, imagePaths?: string[]): boolean {
        return !!imagePaths?.length && this.isLiveCodingQuestion(question);
    }

    getRecapLLM(): RecapLLM | null {
        return this.recapLLM;
    }

    getFallbackExecutor(): FallbackExecutor {
        return this.fallbackExecutor;
    }

    // ============================================
    // LLM Initialization
    // ============================================

    /**
     * Initialize or Re-Initialize mode-specific LLMs with shared Gemini client and Groq client
     * Must be called after API keys are updated.
     */
    initializeLLMs(): void {
        console.log(`[IntelligenceEngine] Initializing LLMs with LLMHelper`);
        this.answerLLM = new AnswerLLM(this.llmHelper);
        this.assistLLM = new AssistLLM(this.llmHelper);
        this.followUpLLM = new FollowUpLLM(this.llmHelper);
        this.recapLLM = new RecapLLM(this.llmHelper);
        this.followUpQuestionsLLM = new FollowUpQuestionsLLM(this.llmHelper);
        this.whatToAnswerLLM = new WhatToAnswerLLM(this.llmHelper);

        // Sync RecapLLM reference to SessionTracker for epoch compaction
        this.session.setRecapLLM(this.recapLLM);
    }

    reinitializeLLMs(): void {
        this.initializeLLMs();
    }

    // ============================================
    // Transcript Handling (delegates to SessionTracker)
    // ============================================

    /**
     * Process transcript from native audio, and trigger follow-up if appropriate
     */
    handleTranscript(segment: TranscriptSegment, skipRefinementCheck: boolean = false): void {
        const result = this.session.handleTranscript(segment);
        this.lastTranscriptTime = Date.now();

        // Check for follow-up intent if user is speaking
        if (result && !skipRefinementCheck && result.role === 'user' && this.session.getLastAssistantMessage()) {
            const { isRefinement, intent } = detectRefinementIntent(segment.text.trim());
            if (isRefinement) {
                this.runFollowUp(intent, segment.text.trim());
            }
        }
    }

    /**
     * Handle suggestion trigger from native audio service
     * This is the primary auto-trigger path
     */
    async handleSuggestionTrigger(trigger: SuggestionTrigger): Promise<void> {
        if (trigger.confidence < 0.5) {
            return;
        }
        await this.runWhatShouldISay(trigger.lastQuestion, trigger.confidence);
    }

    // ============================================
    // Mode Executors
    // ============================================

    /**
     * MODE 1: Assist (Passive)
     * Low-priority observational insights
     */
    async runAssistMode(): Promise<string | null> {
        if (this.activeMode !== 'idle' && this.activeMode !== 'assist') {
            return null;
        }

        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
        }

        this.assistCancellationToken = new AbortController();
        this.setMode('assist');

        try {
            if (!this.assistLLM) {
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(60);
            if (!context) {
                this.setMode('idle');
                return null;
            }

            const insight = await this.assistLLM.generate(context);

            if (this.assistCancellationToken?.signal.aborted) {
                return null;
            }

            if (insight) {
                this.emit('assist_update', insight);
            }
            this.setMode('idle');
            return insight;

        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                return null;
            }
            this.emit('error', error as Error, 'assist');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 2: What Should I Say (Primary)
     * Manual trigger - uses clean transcript pipeline for question inference
     * NEVER returns null - always provides a usable response
     */
    async runWhatShouldISay(question?: string, confidence: number = 0.8, imagePaths?: string[]): Promise<string | null> {
        const now = Date.now();
        let activeLatencyRequestId: string | null = null;
        let activeProfileEnrichmentRoute = false;
        let profileEnrichmentFailed = false;
        let fallbackResponsePrepared = false;
        let syntheticFallbackPending = false;

        if (now - this.lastTriggerTime < this.triggerCooldown && this.activeMode !== 'what_to_say') {
            return null;
        }

        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('what_to_say');
        this.lastTriggerTime = now;
        const requestSequence = ++this.activeWhatToSayRequestId;

        try {
            if (!this.whatToAnswerLLM) {
                if (!this.answerLLM) {
                    this.setMode('idle');
                    return "Please configure your API Keys in Settings to use this feature.";
                }
                const context = this.session.getFormattedContext(180);
                let answer = await this.answerLLM.generate(question || '', context);
                if (answer) {
                // No clamping - prompt enforces brevity
                    this.session.addAssistantMessage(answer);
                    this.emit('suggested_answer', answer, question || 'inferred', confidence);
                }
                this.setMode('idle');
                return answer || "Could you repeat that? I want to make sure I address your question properly.";
            }

            const contextItems = this.session.getContext(180);
            const lastInterim = this.session.getLastInterimInterviewer();
            const interimQuestion = lastInterim?.text?.trim() || '';
            const baseQuestion = question || interimQuestion || this.session.getLastInterviewerTurn() || '';
            const resolvedQuestion = baseQuestion;
            const knowledgeOrchestrator = this.llmHelper.getKnowledgeOrchestrator?.();
            const knowledgeStatus = knowledgeOrchestrator?.getStatus?.();
            const currentReasoningThread = this.session.getActiveReasoningThread();
            const preRouteConsciousDecision = this.session.isConsciousModeEnabled()
                ? classifyConsciousModeQuestion(baseQuestion, currentReasoningThread)
                : { qualifies: false, threadAction: 'ignore' as const };
            const activeReasoningThread = preRouteConsciousDecision.threadAction === 'reset'
                ? null
                : currentReasoningThread;

            if (preRouteConsciousDecision.threadAction === 'reset') {
                this.session.clearConsciousModeThread();
            }

            const selectedRoute = selectAnswerRoute({
                explicitManual: false,
                explicitFollowUp: false,
                consciousModeEnabled: this.session.isConsciousModeEnabled(),
                profileModeEnabled: !!knowledgeStatus?.activeMode,
                hasProfile: !!knowledgeStatus?.hasResume,
                hasKnowledgeData: !!knowledgeStatus?.hasResume || !!knowledgeStatus?.hasActiveJD,
                latestQuestion: baseQuestion,
                activeReasoningThread,
            });
            const shouldUseScreenshotConsciousRoute = this.session.isConsciousModeEnabled()
                && !preRouteConsciousDecision.qualifies
                && this.isScreenshotBackedLiveCodingTurn(resolvedQuestion, imagePaths);
            const capability = typeof (this.llmHelper as any).getProviderCapabilityClass === 'function'
                ? (this.llmHelper as any).getProviderCapabilityClass()
                : 'buffered';
            let effectiveRoute: AnswerRoute = shouldUseScreenshotConsciousRoute ? 'conscious_answer' : selectedRoute;
            let isProfileEnrichmentRoute = effectiveRoute === 'enriched_standard_answer';
            activeProfileEnrichmentRoute = isProfileEnrichmentRoute;
            const requestId = this.latencyTracker.start(effectiveRoute, capability, {
                transcriptRevision: this.session.getTranscriptRevision(),
                fallbackOccurred: false,
                interimQuestionSubstitutionOccurred: !question && !!interimQuestion,
                profileEnrichmentState: isProfileEnrichmentRoute ? 'attempted' : undefined,
                consciousPath: effectiveRoute === 'conscious_answer'
                    ? preRouteConsciousDecision.threadAction === 'continue'
                        ? 'thread_continue'
                        : 'fresh_start'
                    : undefined,
            });
            activeLatencyRequestId = requestId;
            this.latencyTracker.mark(requestId, 'contextLoaded');

            const lastInterviewerTurn = this.session.getLastInterviewerTurn();

            const runFastStandardAnswer = async (): Promise<string> => {
                const preparedTranscript = this.buildFastStandardTranscriptContext(
                    resolvedQuestion,
                    this.session.getLastAssistantMessage()
                );
                this.latencyTracker.mark(requestId, 'transcriptPrepared');

                let fullAnswer = "";
                let fallbackResponsePrepared = false;
                let syntheticFallbackPending = false;
                const noteFallbackResponsePrepared = () => {
                    fallbackResponsePrepared = true;
                    syntheticFallbackPending = true;
                };
                const stream = this.whatToAnswerLLM!.generateStream(preparedTranscript, undefined, undefined, imagePaths, {
                    fastPath: true,
                    latestQuestion: resolvedQuestion,
                    onFallbackResponsePrepared: noteFallbackResponsePrepared,
                });
                this.latencyTracker.markProviderRequestStarted(requestId);

      for await (const token of stream) {
        if (requestSequence !== this.activeWhatToSayRequestId) {
          try {
            await stream.return?.(undefined);
          } catch {
            // Stream cleanup failed - safe to ignore
          }
          break;
        }
                    if (fallbackResponsePrepared) {
                        this.latencyTracker.markFallbackOccurred(requestId);
                        fallbackResponsePrepared = false;
                    }
                    if (!fullAnswer) {
                        if (syntheticFallbackPending) {
                            this.latencyTracker.markFirstVisibleAnswer(requestId);
                            syntheticFallbackPending = false;
                        } else {
                            this.latencyTracker.markFirstStreamingUpdate(requestId);
                        }
                    }
                    this.emit('suggested_answer_token', token, question || 'inferred', confidence);
                    fullAnswer += token;
                }

                if (requestSequence !== this.activeWhatToSayRequestId) {
                    this.latencyTracker.complete(requestId);
                    return fullAnswer;
                }

                if (!fullAnswer || fullAnswer.trim().length < 5) {
                    fullAnswer = "Could you repeat that? I want to make sure I address your question properly.";
                }

                this.session.addAssistantMessage(fullAnswer);

                this.session.pushUsage({
                    type: 'assist',
                    timestamp: Date.now(),
                    question: question || 'What to Answer',
                    answer: fullAnswer
                });

                this.emit('suggested_answer', fullAnswer, question || 'What to Answer', confidence);
                const latencySnapshot = this.latencyTracker.complete(requestId);
                console.log('[IntelligenceEngine] Answer latency snapshot:', latencySnapshot);

                this.setMode('idle');
                return fullAnswer;
            };

            if (isProfileEnrichmentRoute) {
                const timeoutSentinel = Symbol('profile_enrichment_timeout');
                const processQuestion = knowledgeOrchestrator?.processQuestion?.bind(knowledgeOrchestrator);

                try {
                    const enrichmentResult = await Promise.race([
                        processQuestion
                            ? Promise.resolve(processQuestion(resolvedQuestion))
                            : new Promise<typeof timeoutSentinel>(() => {
                                // No preflight enrichment hook is available. Let the enriched route
                                // continue and rely on the normal knowledge interception path.
                            }),
                        new Promise<typeof timeoutSentinel>((resolve) => {
                            setTimeout(() => resolve(timeoutSentinel), PROFILE_ENRICHMENT_TIMEOUT_MS);
                        }),
                    ]);

                    if (processQuestion && (enrichmentResult === timeoutSentinel || !this.hasUsableProfileGrounding(enrichmentResult))) {
                        const fallbackReason = enrichmentResult === timeoutSentinel
                            ? 'profile_timeout'
                            : 'profile_no_context';
                        profileEnrichmentFailed = true;
                        effectiveRoute = 'fast_standard_answer';
                        isProfileEnrichmentRoute = false;
                        activeProfileEnrichmentRoute = false;
                        this.latencyTracker.markFallbackOccurred(requestId, fallbackReason);
                        this.latencyTracker.markDegradedToRoute(requestId, effectiveRoute, {
                            profileEnrichmentState: fallbackReason === 'profile_timeout' ? 'timed_out' : 'failed',
                            profileFallbackReason: fallbackReason,
                        });
                    }
                } catch (_error) {
                    profileEnrichmentFailed = true;
                    effectiveRoute = 'fast_standard_answer';
                    isProfileEnrichmentRoute = false;
                    activeProfileEnrichmentRoute = false;
                    this.latencyTracker.markFallbackOccurred(requestId, 'profile_error');
                    this.latencyTracker.markDegradedToRoute(requestId, effectiveRoute, {
                        profileEnrichmentState: 'failed',
                        profileFallbackReason: 'profile_error',
                    });
                }
            }

            if (effectiveRoute === 'fast_standard_answer') {
                return runFastStandardAnswer();
            }

            if (preRouteConsciousDecision.threadAction === 'continue' && activeReasoningThread && this.followUpLLM) {
                this.latencyTracker.markProviderRequestStarted(requestId);
                const continuationRevision = this.session.getTranscriptRevision();
                const structuredResponse = await this.followUpLLM.generateReasoningFirstFollowUp(
                    activeReasoningThread,
                    resolvedQuestion,
                    this.session.getFormattedContext(180)
                );

                const continuationStale = requestSequence !== this.activeWhatToSayRequestId
                    || this.session.getTranscriptRevision() !== continuationRevision;

                if (continuationStale || !isValidConsciousModeResponse(structuredResponse)) {
                    effectiveRoute = 'fast_standard_answer';
                    this.latencyTracker.markFallbackOccurred(requestId);
                    this.latencyTracker.markDegradedToRoute(requestId, effectiveRoute);
                    return runFastStandardAnswer();
                }

                this.setMode('reasoning_first');

                const fullAnswer = formatConsciousModeResponse(structuredResponse);
                this.session.recordConsciousResponse(resolvedQuestion, structuredResponse, 'continue');
                this.emit('suggested_answer_token', fullAnswer, question || 'What to Answer', confidence);
                this.latencyTracker.markFirstVisibleAnswer(requestId);
                this.session.addAssistantMessage(fullAnswer);
                this.session.pushUsage({
                    type: 'assist',
                    timestamp: Date.now(),
                    question: question || 'What to Answer',
                    answer: fullAnswer
                });
                this.emit('suggested_answer', fullAnswer, question || 'What to Answer', confidence);
                const latencySnapshot = this.latencyTracker.complete(requestId);
                console.log('[IntelligenceEngine] Answer latency snapshot:', latencySnapshot);
                this.setMode('idle');
                return fullAnswer;
            }

            // Inject latest interim transcript if available
            if (lastInterim && lastInterim.text.trim().length > 0) {
                const lastItem = contextItems[contextItems.length - 1];
                const isDuplicate = lastItem &&
                    lastItem.role === 'interviewer' &&
                    (lastItem.text === lastInterim.text || Math.abs(lastItem.timestamp - lastInterim.timestamp) < 1000);

                if (!isDuplicate) {
                    console.log(`[IntelligenceEngine] Injecting interim transcript: "${lastInterim.text.substring(0, 50)}..."`);
                    contextItems.push({
                        role: 'interviewer',
                        text: lastInterim.text,
                        timestamp: lastInterim.timestamp
                    });
                }
            }

            const transcriptTurns = contextItems.map(item => ({
                role: item.role,
                text: item.text,
                timestamp: item.timestamp
            }));
            const preparedTranscript = prepareTranscriptForWhatToAnswer(transcriptTurns, 12);
            this.latencyTracker.mark(requestId, 'transcriptPrepared');
            const temporalContext = buildTemporalContext(
                contextItems,
                this.session.getAssistantResponseHistory(),
                180
            );
            const intentResult = await this.classifyIntentForRoute(
                lastInterviewerTurn,
                preparedTranscript,
                this.session.getAssistantResponseHistory().length
            );
            if (isProfileEnrichmentRoute) {
                this.latencyTracker.annotate(requestId, {
                    profileFallbackReason: undefined,
                });
            }
            this.latencyTracker.mark(requestId, 'enrichmentReady');
            const consciousRoute = effectiveRoute === 'conscious_answer'
                ? (shouldUseScreenshotConsciousRoute
                    ? { qualifies: true, threadAction: 'start' as const }
                    : classifyConsciousModeQuestion(resolvedQuestion, activeReasoningThread))
                : { qualifies: false, threadAction: 'ignore' as const };
            const standardRouteAfterConsciousFallback = effectiveRoute === 'conscious_answer'
                ? selectAnswerRoute({
                    explicitManual: false,
                    explicitFollowUp: false,
                    consciousModeEnabled: false,
                    profileModeEnabled: !!knowledgeStatus?.activeMode,
                    hasProfile: !!knowledgeStatus?.hasResume,
                    hasKnowledgeData: !!knowledgeStatus?.hasResume || !!knowledgeStatus?.hasActiveJD,
                    latestQuestion: resolvedQuestion,
                    activeReasoningThread: null,
                })
                : effectiveRoute;

            if (consciousRoute.threadAction === 'reset') {
                this.session.clearConsciousModeThread();
            }

            if (!consciousRoute.qualifies && consciousRoute.threadAction === 'reset') {
                // Thread already cleared above so non-Conscious fallback cannot reuse stale state.
            }

            if (consciousRoute.qualifies) {
                let structuredResponse;
                if (this.whatToAnswerLLM) {
                    this.latencyTracker.markProviderRequestStarted(requestId);
                    structuredResponse = await this.whatToAnswerLLM.generateReasoningFirst(
                        preparedTranscript,
                        resolvedQuestion,
                        temporalContext,
                        intentResult,
                        imagePaths
                    );
                } else if (this.answerLLM) {
                    this.latencyTracker.markProviderRequestStarted(requestId);
                    structuredResponse = await this.answerLLM.generateReasoningFirst(
                        resolvedQuestion,
                        this.session.getFormattedContext(180)
                    );
                }

                if (isValidConsciousModeResponse(structuredResponse)) {
                    console.log(`[IntelligenceEngine] Temporal RAG: ${temporalContext.previousResponses.length} responses, tone: ${temporalContext.toneSignals[0]?.type || 'neutral'}, intent: conscious_reasoning${imagePaths?.length ? `, with ${imagePaths.length} image(s)` : ''}`);
                    this.setMode('reasoning_first');

                    const fullAnswer = formatConsciousModeResponse(structuredResponse);

                    if (consciousRoute.threadAction !== 'ignore' && resolvedQuestion) {
                        this.session.recordConsciousResponse(
                            resolvedQuestion,
                            structuredResponse,
                            consciousRoute.threadAction === 'start' ? 'start' : consciousRoute.threadAction === 'reset' ? 'reset' : 'continue'
                        );
                    }

                    this.emit('suggested_answer_token', fullAnswer, question || 'What to Answer', confidence);
                    this.latencyTracker.markFirstVisibleAnswer(requestId);
                    this.session.addAssistantMessage(fullAnswer);
                    this.session.pushUsage({
                        type: 'assist',
                        timestamp: Date.now(),
                        question: question || 'What to Answer',
                        answer: fullAnswer
                     });
                     this.emit('suggested_answer', fullAnswer, question || 'What to Answer', confidence);
                     const latencySnapshot = this.latencyTracker.complete(requestId);
                     console.log('[IntelligenceEngine] Answer latency snapshot:', latencySnapshot);
                     this.setMode('idle');
                     return fullAnswer;
                }

                effectiveRoute = standardRouteAfterConsciousFallback;
                isProfileEnrichmentRoute = effectiveRoute === 'enriched_standard_answer';
                activeProfileEnrichmentRoute = isProfileEnrichmentRoute;
                this.latencyTracker.markFallbackOccurred(requestId);
                this.latencyTracker.markDegradedToRoute(requestId, effectiveRoute, {
                    profileEnrichmentState: isProfileEnrichmentRoute ? 'attempted' : undefined,
                    profileFallbackReason: undefined,
                });
            }

            const temporalResponseCount = temporalContext?.previousResponses.length ?? 0;
            const temporalTone = temporalContext?.toneSignals[0]?.type || 'neutral';
            const detectedIntent = intentResult?.intent || 'general';
            console.log(`[IntelligenceEngine] Temporal RAG: ${temporalResponseCount} responses, tone: ${temporalTone}, intent: ${detectedIntent}${imagePaths?.length ? `, with ${imagePaths.length} image(s)` : ''}`);

            let fullAnswer = "";
            const annotateProfileEnrichmentFailure = (failure: { kind: 'timeout' | 'error' }) => {
                if (!isProfileEnrichmentRoute) {
                    return;
                }

                profileEnrichmentFailed = true;
                const timedOut = failure.kind === 'timeout';

                this.latencyTracker.markProfileEnrichmentState(requestId, timedOut ? 'timed_out' : 'failed', timedOut ? 'profile_timeout' : 'profile_error');
            };
            const noteFallbackResponsePrepared = () => {
                fallbackResponsePrepared = true;
                syntheticFallbackPending = true;
            };
            const stream = this.whatToAnswerLLM.generateStream(preparedTranscript, temporalContext, intentResult, imagePaths, {
                fastPath: effectiveRoute === 'fast_standard_answer',
                latestQuestion: resolvedQuestion,
                onInitialStreamFailure: annotateProfileEnrichmentFailure,
                onFallbackResponsePrepared: noteFallbackResponsePrepared,
            });
            this.latencyTracker.markProviderRequestStarted(requestId);

      for await (const token of stream) {
        if (requestSequence !== this.activeWhatToSayRequestId) {
          try {
            await stream.return?.(undefined);
          } catch {
            // Stream cleanup failed - safe to ignore
          }
          break;
        }
                if (fallbackResponsePrepared) {
                    this.latencyTracker.markFallbackOccurred(requestId);
                    fallbackResponsePrepared = false;
                }
                if (!fullAnswer) {
                    if (syntheticFallbackPending) {
                        this.latencyTracker.markFirstVisibleAnswer(requestId);
                        syntheticFallbackPending = false;
                    } else {
                        this.latencyTracker.markFirstStreamingUpdate(requestId);
                    }
                }
                this.emit('suggested_answer_token', token, question || 'inferred', confidence);
                fullAnswer += token;
            }

            if (requestSequence !== this.activeWhatToSayRequestId) {
                this.latencyTracker.complete(requestId);
                return fullAnswer;
            }

            if (!fullAnswer || fullAnswer.trim().length < 5) {
                fullAnswer = "Could you repeat that? I want to make sure I address your question properly.";
            }

            // No post-processing - prompt enforces brevity, code blocks preserved

            this.session.addAssistantMessage(fullAnswer);

            this.session.pushUsage({
                type: 'assist',
                timestamp: Date.now(),
                question: question || 'What to Answer',
                answer: fullAnswer
            });

            this.emit('suggested_answer', fullAnswer, question || 'What to Answer', confidence);
            if (isProfileEnrichmentRoute) {
                if (!profileEnrichmentFailed) {
                    this.latencyTracker.markProfileEnrichmentState(requestId, 'completed');
                }
            }
            const latencySnapshot = this.latencyTracker.complete(requestId);
            console.log('[IntelligenceEngine] Answer latency snapshot:', latencySnapshot);

            this.setMode('idle');
            return fullAnswer;

        } catch (error) {
            if (activeLatencyRequestId) {
                if (activeProfileEnrichmentRoute) {
                    const errorMessage = error instanceof Error ? `${error.name}: ${error.message}`.toLowerCase() : String(error).toLowerCase();
                    const timedOut = errorMessage.includes('timeout') || errorMessage.includes('timed out') || errorMessage.includes('abort');
                    this.latencyTracker.annotate(activeLatencyRequestId, {
                        fallbackOccurred: true,
                        profileEnrichmentState: timedOut ? 'timed_out' : 'failed',
                        profileFallbackReason: timedOut ? 'profile_timeout' : 'profile_error',
                    });
                }
                const latencySnapshot = this.latencyTracker.complete(activeLatencyRequestId);
                console.log('[IntelligenceEngine] Answer latency snapshot:', latencySnapshot);
            }
            this.emit('error', error as Error, 'what_to_say');
            this.setMode('idle');
            return "Could you repeat that? I want to make sure I address your question properly.";
        }
    }

    /**
     * MODE 3: Follow-Up (Refinement)
     * Modify the last assistant message
     */
    async runFollowUp(intent: string, userRequest?: string): Promise<string | null> {
        console.log(`[IntelligenceEngine] runFollowUp called with intent: ${intent}`);
        const lastMsg = this.session.getLastAssistantMessage();
        if (!lastMsg) {
            console.warn('[IntelligenceEngine] No lastAssistantMessage found for follow-up');
            return null;
        }

        this.setMode('follow_up');

        try {
            if (!this.followUpLLM) {
                console.error('[IntelligenceEngine] FollowUpLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(60);
            const refinementRequest = userRequest || intent;

            let fullRefined = "";
            const stream = this.followUpLLM.generateStream(
                lastMsg,
                refinementRequest,
                context
            );

            for await (const token of stream) {
                this.emit('refined_answer_token', token, intent);
                fullRefined += token;
            }

            if (fullRefined) {
                this.session.addAssistantMessage(fullRefined);
                this.emit('refined_answer', fullRefined, intent);

                const intentMap: Record<string, string> = {
                    'shorten': 'Shorten Answer',
                    'expand': 'Expand Answer',
                    'rephrase': 'Rephrase Answer',
                    'add_example': 'Add Example',
                    'more_confident': 'Make More Confident',
                    'more_casual': 'Make More Casual',
                    'more_formal': 'Make More Formal',
                    'simplify': 'Simplify Answer'
                };

                const displayQuestion = userRequest || intentMap[intent] || `Refining: ${intent}`;

                this.session.pushUsage({
                    type: 'followup',
                    timestamp: Date.now(),
                    question: displayQuestion,
                    answer: fullRefined
                });
            }

            this.setMode('idle');
            return fullRefined;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 4: Recap (Summary)
     * Neutral conversation summary
     */
    async runRecap(): Promise<string | null> {
        console.log('[IntelligenceEngine] runRecap called');
        this.setMode('recap');

        try {
            if (!this.recapLLM) {
                console.error('[IntelligenceEngine] RecapLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(120);
            if (!context) {
                console.warn('[IntelligenceEngine] No context available for recap');
                this.setMode('idle');
                return null;
            }

            let fullSummary = "";
            const stream = this.recapLLM.generateStream(context);

            for await (const token of stream) {
                this.emit('recap_token', token);
                fullSummary += token;
            }

            if (fullSummary) {
                this.emit('recap', fullSummary);

                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: 'Recap Meeting',
                    answer: fullSummary
                });
            }
            this.setMode('idle');
            return fullSummary;

        } catch (error) {
            this.emit('error', error as Error, 'recap');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 6: Follow-Up Questions
     * Suggest strategic questions for the user to ask
     */
    async runFollowUpQuestions(): Promise<string | null> {
        console.log('[IntelligenceEngine] runFollowUpQuestions called');
        this.setMode('follow_up_questions');

        try {
            if (!this.followUpQuestionsLLM) {
                console.error('[IntelligenceEngine] FollowUpQuestionsLLM not initialized');
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(120);
            if (!context) {
                console.warn('[IntelligenceEngine] No context available for follow-up questions');
                this.setMode('idle');
                return null;
            }

            let fullQuestions = "";
            const stream = this.followUpQuestionsLLM.generateStream(context);

            for await (const token of stream) {
                this.emit('follow_up_questions_token', token);
                fullQuestions += token;
            }

            if (fullQuestions) {
                this.emit('follow_up_questions_update', fullQuestions);
                this.session.pushUsage({
                    type: 'followup_questions',
                    timestamp: Date.now(),
                    question: 'Generate Follow-up Questions',
                    answer: fullQuestions
                });
            }
            this.setMode('idle');
            return fullQuestions;

        } catch (error) {
            this.emit('error', error as Error, 'follow_up_questions');
            this.setMode('idle');
            return null;
        }
    }

    /**
     * MODE 5: Manual Answer (Fallback)
     * Explicit bypass when auto-detection fails
     */
    async runManualAnswer(question: string): Promise<string | null> {
        this.emit('manual_answer_started');
        this.setMode('manual');

        try {
            if (!this.answerLLM) {
                this.setMode('idle');
                return null;
            }

            const context = this.session.getFormattedContext(120);
            const answer = await this.answerLLM.generate(question, context);

            if (answer) {
                this.session.addAssistantMessage(answer);
                this.emit('manual_answer_result', answer, question);

                this.session.pushUsage({
                    type: 'chat',
                    timestamp: Date.now(),
                    question: question,
                    answer: answer
                });
            }

            this.setMode('idle');
            return answer;

        } catch (error) {
            this.emit('error', error as Error, 'manual');
            this.setMode('idle');
            return null;
        }
    }

    // ============================================
    // State Management
    // ============================================

    private setMode(mode: IntelligenceMode): void {
        if (this.activeMode !== mode) {
            this.activeMode = mode;
            this.emit('mode_changed', mode);
        }
    }

    getActiveMode(): IntelligenceMode {
        return this.activeMode;
    }

  /**
  * Reset engine state (cancels any in-flight operations)
  */
  reset(): void {
    this.activeMode = 'idle';
    if (this.assistCancellationToken) {
      this.assistCancellationToken.abort();
      this.assistCancellationToken = null;
    }
  }

  /**
  * Clean up all event listeners for garbage collection
  */
  override removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}
