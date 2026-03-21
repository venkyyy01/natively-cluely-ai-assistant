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
import { consciousModeRealtimeConfig } from './consciousModeConfig';

// Mode types
export type IntelligenceMode = 'idle' | 'assist' | 'what_to_say' | 'follow_up' | 'recap' | 'manual' | 'follow_up_questions' | 'reasoning_first';

type SuggestionTriggerSource = 'live' | 'manual';

interface SuggestionCycle {
    id: number;
    source: SuggestionTriggerSource;
}

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

    // Timestamps for tracking
    private lastTranscriptTime: number = 0;
    private lastTriggerTime: number = 0;
    private readonly triggerCooldown: number = 3000; // 3 seconds
    private nextSuggestionCycleId: number = 0;
    private latestSuggestionCycleId: number = 0;

    constructor(llmHelper: LLMHelper, session: SessionTracker) {
        super();
        this.llmHelper = llmHelper;
        this.session = session;
        this.initializeLLMs();
    }

    getLLMHelper(): LLMHelper {
        return this.llmHelper;
    }

    getRecapLLM(): RecapLLM | null {
        return this.recapLLM;
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

        if (now - this.lastTriggerTime < this.triggerCooldown) {
            return null;
        }

        const cycle = this.beginSuggestionCycle('live');

        if (this.assistCancellationToken) {
            this.assistCancellationToken.abort();
            this.assistCancellationToken = null;
        }

        this.setMode('what_to_say');
        this.lastTriggerTime = now;

        try {
            return await this.runSuggestionCycle({ question, confidence, imagePaths, source: 'live', cycle });

        } catch (error) {
            this.emit('error', error as Error, 'what_to_say');
            this.finishSuggestionCycle(cycle);
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
        const cycle = this.beginSuggestionCycle('manual');
        this.emit('manual_answer_started');
        this.setMode('manual');

        try {
            return await this.runSuggestionCycle({
                question,
                confidence: 0.8,
                source: 'manual',
                cycle,
            });

        } catch (error) {
            this.emit('error', error as Error, 'manual');
            this.finishSuggestionCycle(cycle);
            return null;
        }
    }

    private async runSuggestionCycle({
        question,
        confidence,
        imagePaths,
        source,
        cycle,
    }: {
        question?: string;
        confidence: number;
        imagePaths?: string[];
        source: SuggestionTriggerSource;
        cycle: SuggestionCycle;
    }): Promise<string | null> {
        const contextItems = this.session.getContext(180);

        const lastInterim = this.session.getLastInterimInterviewer();
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
        const temporalContext = buildTemporalContext(
            contextItems,
            this.session.getAssistantResponseHistory(),
            180
        );
        const lastInterviewerTurn = this.session.getLastInterviewerTurn();
        const activeReasoningThread = this.session.getActiveReasoningThread();
        const suspendedReasoningThread = this.session.getSuspendedReasoningThread();
        const resolvedQuestion = question || lastInterviewerTurn || '';

        const intentResult = await classifyIntent(
            lastInterviewerTurn,
            preparedTranscript,
            this.session.getAssistantResponseHistory().length
        );

        const consciousRoute = this.session.isConsciousModeEnabled()
            ? classifyConsciousModeQuestion(resolvedQuestion, activeReasoningThread, intentResult.intent, suspendedReasoningThread)
            : { qualifies: false, threadAction: 'ignore' as const, confidence: 0 };
        const manualLiveAttach = source === 'manual'
            && (consciousRoute.threadAction === 'continue' || consciousRoute.threadAction === 'resume')
            && consciousRoute.confidence >= 0.9;
        const shouldMutateThread = source === 'live' || manualLiveAttach;
        const shouldUseThreadContext = shouldMutateThread
            && (consciousRoute.threadAction === 'continue' || consciousRoute.threadAction === 'resume');

        if (this.session.isConsciousModeDegraded()) {
            return this.runFallbackSuggestion({
                preparedTranscript,
                temporalContext,
                intentResult,
                question,
                resolvedQuestion,
                confidence,
                imagePaths,
                source,
                cycle,
            });
        }

        const consciousGenerationPromise = (async () => {
            if (consciousRoute.qualifies) {
                if (consciousRoute.threadAction === 'continue' && activeReasoningThread && this.followUpLLM && shouldUseThreadContext) {
                    return await this.followUpLLM.generateReasoningFirstFollowUp(
                        activeReasoningThread,
                        resolvedQuestion,
                        this.session.getFormattedContext(180)
                    );
                } else if (consciousRoute.threadAction === 'resume' && suspendedReasoningThread && this.followUpLLM && shouldUseThreadContext) {
                    return await this.followUpLLM.generateReasoningFirstFollowUp(
                        suspendedReasoningThread,
                        resolvedQuestion,
                        this.session.getFormattedContext(180)
                    );
                } else if (this.whatToAnswerLLM) {
                    return await this.whatToAnswerLLM.generateReasoningFirst(
                        preparedTranscript,
                        resolvedQuestion,
                        temporalContext,
                        intentResult,
                        imagePaths
                    );
                } else if (this.answerLLM) {
                    return await this.answerLLM.generateReasoningFirst(
                        resolvedQuestion,
                        this.session.getFormattedContext(180)
                    );
                }
            }
            return null;
        })();

        const timeoutPromise = new Promise<null>((resolve) => 
            setTimeout(() => resolve(null), consciousModeRealtimeConfig.structuredGenerationTimeoutMs)
        );

        const structuredResponse = await Promise.race([
            consciousGenerationPromise,
            timeoutPromise,
        ]);

        if (structuredResponse && isValidConsciousModeResponse(structuredResponse)) {
            if (!this.isCurrentSuggestionCycle(cycle)) {
                return null;
            }

            console.log(`[IntelligenceEngine] Temporal RAG: ${temporalContext.previousResponses.length} responses, tone: ${temporalContext.toneSignals[0]?.type || 'neutral'}, intent: conscious_reasoning${imagePaths?.length ? `, with ${imagePaths.length} image(s)` : ''}`);
            this.setMode('reasoning_first');

            const fullAnswer = formatConsciousModeResponse(structuredResponse);

            if (shouldMutateThread && consciousRoute.threadAction !== 'ignore' && resolvedQuestion) {
                this.applyThreadLifecycle(consciousRoute.threadAction);
                this.session.recordConsciousResponse(
                    resolvedQuestion,
                    structuredResponse,
                    consciousRoute.threadAction
                );
            }

            this.session.recordConsciousSuccess();

            this.publishSuggestionResult({
                answer: fullAnswer,
                confidence,
                question: question || 'What to Answer',
                source,
                cycle,
            });
            this.finishSuggestionCycle(cycle);
            return fullAnswer;
        }

        if (shouldMutateThread && consciousRoute.threadAction === 'reset') {
            this.applyThreadLifecycle('reset');
        }

        if (consciousRoute.qualifies) {
            this.session.recordConsciousFailure();
        }

        return this.runFallbackSuggestion({
            preparedTranscript,
            temporalContext,
            intentResult,
            question,
            resolvedQuestion,
            confidence,
            imagePaths,
            source,
            cycle,
        });
    }

    private async runFallbackSuggestion({
        preparedTranscript,
        temporalContext,
        intentResult,
        question,
        resolvedQuestion,
        confidence,
        imagePaths,
        source,
        cycle,
    }: {
        preparedTranscript: string;
        temporalContext: ReturnType<typeof buildTemporalContext>;
        intentResult: Awaited<ReturnType<typeof classifyIntent>>;
        question?: string;
        resolvedQuestion: string;
        confidence: number;
        imagePaths?: string[];
        source: SuggestionTriggerSource;
        cycle: SuggestionCycle;
    }): Promise<string | null> {
        console.log(`[IntelligenceEngine] Temporal RAG: ${temporalContext.previousResponses.length} responses, tone: ${temporalContext.toneSignals[0]?.type || 'neutral'}, intent: ${intentResult.intent}${imagePaths?.length ? `, with ${imagePaths.length} image(s)` : ''}`);

        let fullAnswer = "";
        if (source === 'manual' && this.answerLLM) {
            fullAnswer = await this.answerLLM.generate(resolvedQuestion, this.session.getFormattedContext(120)) || "";
        } else if (this.whatToAnswerLLM) {
            const stream = this.whatToAnswerLLM.generateStream(preparedTranscript, temporalContext, intentResult, imagePaths);

            for await (const token of stream) {
                if (!this.isCurrentSuggestionCycle(cycle)) {
                    return null;
                }

                if (source === 'live') {
                    this.emit('suggested_answer_token', token, question || 'inferred', confidence);
                }
                fullAnswer += token;
            }
        }

        if (!fullAnswer || fullAnswer.trim().length < 5) {
            fullAnswer = "Could you repeat that? I want to make sure I address your question properly.";
        }

        if (!this.isCurrentSuggestionCycle(cycle)) {
            return null;
        }

        this.publishSuggestionResult({
            answer: fullAnswer,
            confidence,
            question: question || 'What to Answer',
            source,
            cycle,
        });
        this.finishSuggestionCycle(cycle);
        return fullAnswer;
    }

    private publishSuggestionResult({
        answer,
        confidence,
        question,
        source,
        cycle,
    }: {
        answer: string;
        confidence: number;
        question: string;
        source: SuggestionTriggerSource;
        cycle?: SuggestionCycle;
    }): void {
        if (cycle && !this.isCurrentSuggestionCycle(cycle)) {
            return;
        }

        this.session.addAssistantMessage(answer);
        this.session.pushUsage({
            type: source === 'manual' ? 'chat' : 'assist',
            timestamp: Date.now(),
            question,
            answer,
        });

        if (source === 'manual') {
            this.emit('manual_answer_result', answer, question);
            return;
        }

        this.emit('suggested_answer', answer, question, confidence);
    }

    private applyThreadLifecycle(threadAction: ReturnType<typeof classifyConsciousModeQuestion>['threadAction']): void {
        if (threadAction === 'reset') {
            this.session.clearConsciousModeThread();
            return;
        }

        if (threadAction === 'suspend') {
            this.session.suspendActiveReasoningThread();
        }
    }

    private beginSuggestionCycle(source: SuggestionTriggerSource): SuggestionCycle {
        const cycle = {
            id: ++this.nextSuggestionCycleId,
            source,
        };
        this.latestSuggestionCycleId = cycle.id;
        return cycle;
    }

    private isCurrentSuggestionCycle(cycle: SuggestionCycle): boolean {
        return this.latestSuggestionCycleId === cycle.id;
    }

    private finishSuggestionCycle(cycle: SuggestionCycle): void {
        if (this.isCurrentSuggestionCycle(cycle)) {
            this.setMode('idle');
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
}
