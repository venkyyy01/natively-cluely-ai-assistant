// IntelligenceManager.ts
// Thin facade that delegates to focused sub-modules.
// Maintains full backward compatibility — all existing callers continue to work unchanged.
//
// Sub-modules:
//   SessionTracker     — state, transcript arrays, context management, epoch compaction
//   IntelligenceEngine — LLM mode routing (6 modes), event emission
//   MeetingPersistence — meeting stop/save/recovery

import { EventEmitter } from 'events';
import { LLMHelper } from './LLMHelper';
import { SessionTracker } from './SessionTracker';
import { IntelligenceEngine } from './IntelligenceEngine';
import type { SuggestedAnswerMetadata } from './IntelligenceEngine';
import { MeetingPersistence } from './MeetingPersistence';
import type { AccelerationManager } from './services/AccelerationManager';
import type { ConsciousModeStructuredResponse, ReasoningThread } from './ConsciousMode';

// Re-export types for backward compatibility
export type { TranscriptSegment, SuggestionTrigger, ContextItem } from './SessionTracker';
export type { IntelligenceMode, IntelligenceModeEvents } from './IntelligenceEngine';
export type { ConsciousModeStructuredResponse, ReasoningThread } from './ConsciousMode';

export const GEMINI_FLASH_MODEL = "gemini-3.1-flash-lite-preview";

/**
 * IntelligenceManager - Facade for the intelligence layer.
 * 
 * Delegates to:
 * - SessionTracker:     context, transcripts, epoch summaries
 * - IntelligenceEngine: LLM modes (assist, whatToSay, followUp, recap, manual, followUpQuestions)
 * - MeetingPersistence: meeting stop/save/recovery
 */
export class IntelligenceManager extends EventEmitter {
    private session: SessionTracker;
    private engine: IntelligenceEngine;
    private persistence: MeetingPersistence;

    constructor(llmHelper: LLMHelper) {
        super();
        this.session = new SessionTracker();
        this.engine = new IntelligenceEngine(llmHelper, this.session);
        this.persistence = new MeetingPersistence(this.session, llmHelper);

        // Forward all engine events through the facade
        this.forwardEngineEvents();
    }

    /**
     * Forward all events from IntelligenceEngine through this facade
     * so existing listeners on IntelligenceManager continue to work.
     */
    private forwardEngineEvents(): void {
        const events = [
            'assist_update', 'cooldown_deferred', 'suggested_answer', 'suggested_answer_token',
            'refined_answer', 'refined_answer_token',
            'recap', 'recap_token',
            'follow_up_questions_update', 'follow_up_questions_token',
            'manual_answer_started', 'manual_answer_result',
            'mode_changed', 'error'
        ];

        for (const event of events) {
            this.engine.on(event, (...args: any[]) => {
                this.emit(event, ...args);
            });
        }
    }

    override on(event: 'cooldown_deferred', listener: (suppressedMs: number, question?: string, reason?: 'duplicate_question_debounce') => void): this;
    override on(event: 'suggested_answer', listener: (answer: string, question: string, confidence: number, metadata?: SuggestedAnswerMetadata) => void): this;
    override on(event: string | symbol, listener: (...args: any[]) => void): this;
    override on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    // ============================================
    // LLM Initialization (delegates to engine)
    // ============================================

    initializeLLMs(): void {
        this.engine.initializeLLMs();
    }

    reinitializeLLMs(): void {
        this.engine.reinitializeLLMs();
    }

    // ============================================
    // Context Management (delegates to session)
    // ============================================

    setMeetingMetadata(metadata: any): void {
        this.session.setMeetingMetadata(metadata);
        const inferredMeetingId = metadata?.meetingId || metadata?.calendarEventId;
        if (typeof inferredMeetingId === 'string' && inferredMeetingId.trim()) {
            this.session.ensureMeetingContext(inferredMeetingId.trim());
        }
    }

    getSessionTracker(): SessionTracker {
        return this.session;
    }

    attachAccelerationManager(accelerationManager: AccelerationManager | null): void {
        this.engine.attachAccelerationManager(accelerationManager);
    }

    addTranscript(segment: import('./SessionTracker').TranscriptSegment, skipRefinementCheck: boolean = false): void {
        if (skipRefinementCheck) {
            // Direct add without refinement detection
            this.session.addTranscript(segment);
        } else {
            // Let the engine handle transcript + refinement detection
            this.engine.handleTranscript(segment, false);
        }
    }

    addAssistantMessage(text: string): void {
        this.session.addAssistantMessage(text);
    }

    getContext(lastSeconds: number = 120) {
        return this.session.getContext(lastSeconds);
    }

    getLastAssistantMessage(): string | null {
        return this.session.getLastAssistantMessage();
    }

    setConsciousModeEnabled(enabled: boolean): void {
        this.session.setConsciousModeEnabled(enabled);
    }

    cancelActiveWhatToSay(reason?: string): void {
        this.engine.cancelActiveWhatToSay(reason);
    }

    isConsciousModeEnabled(): boolean {
        return this.session.isConsciousModeEnabled();
    }

    getLatestConsciousResponse(): ConsciousModeStructuredResponse | null {
        return this.session.getLatestConsciousResponse();
    }

    getActiveReasoningThread(): ReasoningThread | null {
        return this.session.getActiveReasoningThread();
    }

    getFormattedContext(lastSeconds: number = 120): string {
        return this.session.getFormattedContext(lastSeconds);
    }

    getLastInterviewerTurn(): string | null {
        return this.session.getLastInterviewerTurn();
    }

    logUsage(type: 'assist' | 'followup' | 'chat' | 'followup_questions', question: string, answer: string): void {
        this.session.logUsage(type, question, answer);
    }

    // ============================================
    // Transcript Handling (delegates to engine)
    // ============================================

    handleTranscript(segment: import('./SessionTracker').TranscriptSegment): void {
        this.engine.handleTranscript(segment);
    }

    async handleSuggestionTrigger(trigger: import('./SessionTracker').SuggestionTrigger): Promise<void> {
        return this.engine.handleSuggestionTrigger(trigger);
    }

    // ============================================
    // Mode Executors (delegates to engine)
    // ============================================

    async runAssistMode(): Promise<string | null> {
        return this.engine.runAssistMode();
    }

    async runWhatShouldISay(question?: string, confidence?: number, imagePaths?: string[]): Promise<string | null> {
        return this.engine.runWhatShouldISay(question, confidence, imagePaths);
    }

    async runFollowUp(intent: string, userRequest?: string): Promise<string | null> {
        return this.engine.runFollowUp(intent, userRequest);
    }

    async runRecap(): Promise<string | null> {
        return this.engine.runRecap();
    }

    async runFollowUpQuestions(): Promise<string | null> {
        return this.engine.runFollowUpQuestions();
    }

    async runManualAnswer(question: string): Promise<string | null> {
        return this.engine.runManualAnswer(question);
    }

    // ============================================
    // State Management
    // ============================================

    getActiveMode() {
        return this.engine.getActiveMode();
    }

    setMode(mode: import('./IntelligenceEngine').IntelligenceMode): void {
        // This was private in the original, but kept for compatibility
        (this.engine as any).setMode(mode);
    }

    // ============================================
    // Meeting Lifecycle (delegates to persistence)
    // ============================================

  async stopMeeting(meetingId?: string): Promise<void> {
    if (meetingId) {
      this.session.setActiveMeetingId(meetingId);
    }
    const nextSession = await this.persistence.stopMeeting(meetingId);
    this.session = nextSession;
    this.persistence.setSession(nextSession);
    this.engine.setSession(nextSession);
  }

  async recoverUnprocessedMeetings(): Promise<void> {
    return this.persistence.recoverUnprocessedMeetings();
  }

  async waitForPendingSaves(timeoutMs?: number): Promise<void> {
    return this.persistence.waitForPendingSaves(timeoutMs);
  }

    // ============================================
    // Reset (resets all sub-modules)
    // ============================================

  async reset(): Promise<void> {
    this.engine.removeAllListeners();
    this.removeAllListeners();
    await this.session.reset();
    this.engine.reset();
  }
}
