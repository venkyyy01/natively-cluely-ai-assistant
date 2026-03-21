// SessionTracker.ts
// Manages session state, transcript arrays, context windows, and epoch compaction.
// Extracted from IntelligenceManager to decouple state management from LLM orchestration.

import { RecapLLM } from './llm';
import {
    ConsciousModeThreadAction,
    ConsciousModeStructuredResponse,
    ReasoningThread,
    mergeConsciousModeResponses,
} from './ConsciousMode';
import { consciousModeRealtimeConfig } from './consciousModeConfig';

const DUPLICATE_TRANSCRIPT_WINDOW_MS = 2_000;
const PARTIAL_REVISION_WINDOW_MS = 2_000;
const LOW_CONFIDENCE_REJECTION_THRESHOLD = 0.45;
const SHORT_LOW_CONFIDENCE_TEXT_LENGTH = 4;

export interface TranscriptSegment {
    marker?: string;
    speaker: string;
    text: string;
    timestamp: number;
    final: boolean;
    confidence?: number;
}

export interface SuggestionTrigger {
    context: string;
    lastQuestion: string;
    confidence: number;
}

// Context item matching Swift ContextManager structure
export interface ContextItem {
    role: 'interviewer' | 'user' | 'assistant';
    text: string;
    timestamp: number;
}

export interface AssistantResponse {
    text: string;
    timestamp: number;
    questionContext: string;
}

export class SessionTracker {
    // Context management (mirrors Swift ContextManager)
    private contextItems: ContextItem[] = [];
    private readonly contextWindowDuration: number = 120; // 120 seconds
    private readonly maxContextItems: number = 500;

    // Last assistant message for follow-up mode
    private lastAssistantMessage: string | null = null;

    // Temporal RAG: Track all assistant responses in session for anti-repetition
    private assistantResponseHistory: AssistantResponse[] = [];

    // Meeting metadata
    private currentMeetingMetadata: {
        title?: string;
        calendarEventId?: string;
        source?: 'manual' | 'calendar';
    } | null = null;

    // Full Session Tracking (Persisted)
    private fullTranscript: TranscriptSegment[] = [];
    private fullUsage: any[] = []; // UsageInteraction
    private sessionStartTime: number = Date.now();

    // Rolling summarization: epoch summaries preserve early context when arrays are compacted
    private static readonly MAX_EPOCH_SUMMARIES = 5;
    private transcriptEpochSummaries: string[] = [];
    private isCompacting: boolean = false;

    // Track interim interviewer segment
    private lastInterimInterviewer: TranscriptSegment | null = null;
    private recentAcceptedTranscriptKeys: Array<{ speaker: string; normalizedText: string; timestamp: number }> = [];
    private latestContextInterviewerTimestamp: number = 0;

    // Conscious Mode state
    private consciousModeEnabled: boolean = false;
    private latestConsciousResponse: ConsciousModeStructuredResponse | null = null;
    private activeReasoningThread: ReasoningThread | null = null;
    private suspendedReasoningThread: ReasoningThread | null = null;

    // Degraded mode tracking for repeated failures
    private consecutiveFailures: number = 0;
    private isDegraded: boolean = false;

    // Reference to RecapLLM for epoch summarization (injected later)
    private recapLLM: RecapLLM | null = null;

    // ============================================
    // Configuration
    // ============================================

    public setRecapLLM(recapLLM: RecapLLM | null): void {
        this.recapLLM = recapLLM;
    }

    public setMeetingMetadata(metadata: any): void {
        this.currentMeetingMetadata = metadata;
    }

    public getMeetingMetadata() {
        return this.currentMeetingMetadata;
    }

    public clearMeetingMetadata(): void {
        this.currentMeetingMetadata = null;
    }

    // ============================================
    // Context Management
    // ============================================

    /**
     * Add a transcript segment to context.
     * Only stores FINAL transcripts.
     * Returns { role, isRefinementCandidate } so the engine can decide whether to trigger follow-up.
     */
    addTranscript(segment: TranscriptSegment): { role: 'interviewer' | 'user' | 'assistant' } | null {
        if (!segment.final) return null;

        const role = this.mapSpeakerToRole(segment.speaker);
        const text = segment.text.trim();

        if (!text) return null;

        // Deduplicate: check if this exact item already exists
        const lastItem = this.contextItems[this.contextItems.length - 1];
        if (lastItem &&
            lastItem.role === role &&
            Math.abs(lastItem.timestamp - segment.timestamp) < 500 &&
            lastItem.text === text) {
            return null;
        }

        this.contextItems.push({
            role,
            text,
            timestamp: segment.timestamp
        });

        if (role === 'interviewer') {
            this.latestContextInterviewerTimestamp = Math.max(this.latestContextInterviewerTimestamp, segment.timestamp);
        }

        this.evictOldEntries();

        // Filter out internal system prompts that might be passed via IPC
        const isInternalPrompt = text.startsWith("You are a real-time interview assistant") ||
            text.startsWith("You are a helper") ||
            text.startsWith("CONTEXT:");

        if (!isInternalPrompt) {
            // Add to session transcript
            this.fullTranscript.push(segment);
            // Compact transcript with summarization instead of losing early context
            // Fire-and-forget: sync context; errors are caught internally
            void this.compactTranscriptIfNeeded().catch(e =>
                console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
            );
        }

        return { role };
    }

    /**
     * Add assistant-generated message to context
     */
    addAssistantMessage(text: string): void {
        console.log(`[SessionTracker] addAssistantMessage called with:`, text.substring(0, 50));

        // Natively-style filtering
        if (!text) return;

        const cleanText = text.trim();
        if (cleanText.length < 10) {
            console.warn(`[SessionTracker] Ignored short message (<10 chars)`);
            return;
        }

        if (cleanText.includes("I'm not sure") || cleanText.includes("I can't answer")) {
            console.warn(`[SessionTracker] Ignored fallback message`);
            return;
        }

        this.contextItems.push({
            role: 'assistant',
            text: cleanText,
            timestamp: Date.now()
        });

        // Also add to fullTranscript so it persists in the session history (and summaries)
        this.fullTranscript.push({
            speaker: 'assistant',
            text: cleanText,
            timestamp: Date.now(),
            final: true,
            confidence: 1.0
        });

        // Compact transcript with summarization instead of losing early context
        // Fire-and-forget: sync context; errors are caught internally
        void this.compactTranscriptIfNeeded().catch(e =>
            console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
        );

        this.lastAssistantMessage = cleanText;

        // Temporal RAG: Track response history for anti-repetition
        this.assistantResponseHistory.push({
            text: cleanText,
            timestamp: Date.now(),
            questionContext: this.getLastInterviewerTurn() || 'unknown'
        });

        // Keep history bounded (last 10 responses)
        if (this.assistantResponseHistory.length > 10) {
            this.assistantResponseHistory = this.assistantResponseHistory.slice(-10);
        }

        console.log(`[SessionTracker] lastAssistantMessage updated, history size: ${this.assistantResponseHistory.length}`);
        this.evictOldEntries();
    }

    /**
     * Handle incoming transcript from native audio service
     */
    handleTranscript(segment: TranscriptSegment): { role: 'interviewer' | 'user' | 'assistant' } | null {
        this.promoteBufferedInterviewerIfNeeded(segment);

        if (this.isOverlappingSpeakerFailure(segment)) {
            this.lastInterimInterviewer = null;
            return null;
        }

        // Track interim segments for interviewer to prevent data loss on stop
        if (segment.speaker === 'interviewer') {
            if (Math.random() < 0.05 || segment.final) {
                console.log(`[SessionTracker] RX Interviewer Segment: Final=${segment.final} Text="${segment.text.substring(0, 50)}..."`);
            }

            if (!segment.final) {
                if (this.shouldIgnoreTranscript(segment)) {
                    this.lastInterimInterviewer = null;
                    return null;
                }

                this.lastInterimInterviewer = segment;
                return null;
            }

            if (this.isDuplicateAcceptedTranscript(segment)) {
                this.lastInterimInterviewer = null;
                return null;
            }

            if (segment.timestamp < this.latestContextInterviewerTimestamp) {
                this.lastInterimInterviewer = null;
                this.storeRawTranscriptSegment(segment);
                return null;
            }

            this.lastInterimInterviewer = null;
        }

        if (this.shouldIgnoreTranscript(segment)) {
            return null;
        }

        if (segment.final) {
            this.rememberAcceptedTranscript(segment);
        }

        return this.addTranscript(segment);
    }

    // ============================================
    // Context Accessors
    // ============================================

    /**
     * Get context items within the last N seconds
     */
    getContext(lastSeconds: number = 120): ContextItem[] {
        const cutoff = Date.now() - (lastSeconds * 1000);
        return this.contextItems.filter(item => item.timestamp >= cutoff);
    }

    getLastAssistantMessage(): string | null {
        return this.lastAssistantMessage;
    }

    getAssistantResponseHistory(): AssistantResponse[] {
        return this.assistantResponseHistory;
    }

    getLastInterimInterviewer(): TranscriptSegment | null {
        return this.lastInterimInterviewer;
    }

    setConsciousModeEnabled(enabled: boolean): void {
        this.consciousModeEnabled = enabled;
        if (!enabled) {
            this.latestConsciousResponse = null;
            this.activeReasoningThread = null;
            this.suspendedReasoningThread = null;
        }
    }

    isConsciousModeEnabled(): boolean {
        return this.consciousModeEnabled;
    }

    getLatestConsciousResponse(): ConsciousModeStructuredResponse | null {
        return this.latestConsciousResponse;
    }

    getActiveReasoningThread(): ReasoningThread | null {
        return this.activeReasoningThread;
    }

    getSuspendedReasoningThread(): ReasoningThread | null {
        return this.suspendedReasoningThread;
    }

    suspendActiveReasoningThread(): void {
        if (!this.activeReasoningThread) {
            return;
        }

        this.suspendedReasoningThread = {
            ...this.activeReasoningThread,
            state: 'suspended',
            suspendedAt: Date.now(),
        };
        this.activeReasoningThread = null;
    }

    clearConsciousModeThread(): void {
        this.latestConsciousResponse = null;
        this.activeReasoningThread = null;
        this.suspendedReasoningThread = null;
    }

    recordConsciousResponse(question: string, response: ConsciousModeStructuredResponse, threadAction: ConsciousModeThreadAction): void {
        if (threadAction === 'reset' || threadAction === 'suspend') {
            return;
        }

        this.latestConsciousResponse = response;

        if (threadAction === 'continue' && this.activeReasoningThread?.state !== 'suspended') {
            this.activeReasoningThread = {
                ...this.activeReasoningThread,
                lastQuestion: question,
                followUpCount: this.activeReasoningThread.followUpCount + 1,
                response: mergeConsciousModeResponses(this.activeReasoningThread.response, response),
                state: 'active',
                suspendedAt: undefined,
                updatedAt: Date.now(),
            };
            this.latestConsciousResponse = this.activeReasoningThread.response;
            return;
        }

        if (threadAction === 'resume' && this.suspendedReasoningThread) {
            const previousActiveThread = this.activeReasoningThread
                ? {
                    ...this.activeReasoningThread,
                    state: 'suspended' as const,
                    suspendedAt: Date.now(),
                }
                : null;

            this.activeReasoningThread = {
                ...this.suspendedReasoningThread,
                lastQuestion: question,
                followUpCount: this.suspendedReasoningThread.followUpCount + 1,
                response: mergeConsciousModeResponses(this.suspendedReasoningThread.response, response),
                state: 'active',
                suspendedAt: undefined,
                updatedAt: Date.now(),
            };
            this.suspendedReasoningThread = previousActiveThread;
            this.latestConsciousResponse = this.activeReasoningThread.response;
            return;
        }

        this.activeReasoningThread = {
            rootQuestion: question,
            lastQuestion: question,
            response,
            followUpCount: 0,
            state: 'active',
            suspendedAt: undefined,
            updatedAt: Date.now(),
        };
    }

    recordConsciousFailure(): void {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= consciousModeRealtimeConfig.repeatedFailureThreshold) {
            this.isDegraded = true;
        }
    }

    recordConsciousSuccess(): void {
        this.consecutiveFailures = 0;
        this.isDegraded = false;
    }

    isConsciousModeDegraded(): boolean {
        return this.isDegraded;
    }

    getConsciousModeDegradedFlag(): boolean {
        return this.isDegraded;
    }

    getConsciousModeConsecutiveFailures(): number {
        return this.consecutiveFailures;
    }

    /**
     * Get formatted context string for LLM prompts
     */
    getFormattedContext(lastSeconds: number = 120): string {
        const items = this.getContext(lastSeconds);
        return items.map(item => {
            const label = item.role === 'interviewer' ? 'INTERVIEWER' :
                item.role === 'user' ? 'ME' :
                    'ASSISTANT (PREVIOUS SUGGESTION)';
            return `[${label}]: ${item.text}`;
        }).join('\n');
    }

    /**
     * Get the last interviewer turn
     */
    getLastInterviewerTurn(): string | null {
        for (let i = this.contextItems.length - 1; i >= 0; i--) {
            if (this.contextItems[i].role === 'interviewer') {
                return this.contextItems[i].text;
            }
        }
        return null;
    }

    /**
     * Get full session context from accumulated transcript (User + Interviewer + Assistant)
     */
    getFullSessionContext(): string {
        const recentTranscript = this.fullTranscript.map(segment => {
            const role = this.mapSpeakerToRole(segment.speaker);
            const label = role === 'interviewer' ? 'INTERVIEWER' :
                role === 'user' ? 'ME' :
                    'ASSISTANT';
            return `[${label}]: ${segment.text}`;
        }).join('\n');

        // Prepend epoch summaries for full session context preservation
        if (this.transcriptEpochSummaries.length > 0) {
            const epochContext = this.transcriptEpochSummaries.join('\n---\n');
            return `[SESSION HISTORY - EARLIER DISCUSSION]\n${epochContext}\n\n[RECENT TRANSCRIPT]\n${recentTranscript}`;
        }

        return recentTranscript;
    }

    // ============================================
    // Session Data Accessors (for MeetingPersistence)
    // ============================================

    getFullTranscript(): TranscriptSegment[] {
        return this.fullTranscript;
    }

    getFullUsage(): any[] {
        return this.fullUsage;
    }

    getSessionStartTime(): number {
        return this.sessionStartTime;
    }

    // ============================================
    // Usage Tracking
    // ============================================

    /**
     * Cap usage array with simple eviction (usage doesn't need summarization)
     */
    capUsageArray(): void {
        if (this.fullUsage.length > 500) {
            this.fullUsage = this.fullUsage.slice(-500);
        }
    }

    /**
     * Public method to log usage from external sources (e.g. IPC direct chat)
     */
    logUsage(type: string, question: string, answer: string): void {
        this.fullUsage.push({
            type,
            timestamp: Date.now(),
            question,
            answer
        });
    }

    pushUsage(entry: any): void {
        this.fullUsage.push(entry);
        this.capUsageArray();
    }

    // ============================================
    // Interim Transcript Flush
    // ============================================

    /**
     * Force-save any pending interim transcript (called on meeting stop)
     */
    flushInterimTranscript(): void {
        if (this.lastInterimInterviewer) {
            console.log('[SessionTracker] Force-saving pending interim transcript:', this.lastInterimInterviewer.text);
            const finalSegment = { ...this.lastInterimInterviewer, final: true };
            if (!this.isDuplicateAcceptedTranscript(finalSegment)) {
                this.rememberAcceptedTranscript(finalSegment);
                this.addTranscript(finalSegment);
            }
            this.lastInterimInterviewer = null;
        }
    }

    // ============================================
    // Reset
    // ============================================

    reset(): void {
        const consciousModeEnabled = this.consciousModeEnabled;
        this.contextItems = [];
        this.fullTranscript = [];
        this.fullUsage = [];
        this.transcriptEpochSummaries = [];
        this.sessionStartTime = Date.now();
        this.lastAssistantMessage = null;
        this.assistantResponseHistory = [];
        this.lastInterimInterviewer = null;
        this.recentAcceptedTranscriptKeys = [];
        this.latestContextInterviewerTimestamp = 0;
        this.consciousModeEnabled = consciousModeEnabled;
        this.latestConsciousResponse = null;
        this.activeReasoningThread = null;
        this.suspendedReasoningThread = null;
    }

    // ============================================
    // Private Helpers
    // ============================================

    mapSpeakerToRole(speaker: string): 'interviewer' | 'user' | 'assistant' {
        if (speaker === 'user') return 'user';
        if (speaker === 'assistant') return 'assistant';
        return 'interviewer'; // system audio = interviewer
    }

    private evictOldEntries(): void {
        const cutoff = Date.now() - (this.contextWindowDuration * 1000);
        this.contextItems = this.contextItems.filter(item => item.timestamp >= cutoff);

        // Safety limit
        if (this.contextItems.length > this.maxContextItems) {
            this.contextItems = this.contextItems.slice(-this.maxContextItems);
        }
    }

    private normalizeTranscriptText(text: string): string {
        return text.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    private shouldIgnoreTranscript(segment: TranscriptSegment): boolean {
        const text = segment.text.trim();
        if (!text) {
            return true;
        }

        return (segment.confidence ?? 1) < LOW_CONFIDENCE_REJECTION_THRESHOLD
            && text.length <= SHORT_LOW_CONFIDENCE_TEXT_LENGTH;
    }

    private isDuplicateAcceptedTranscript(segment: TranscriptSegment): boolean {
        const normalizedText = this.normalizeTranscriptText(segment.text);
        return this.recentAcceptedTranscriptKeys.some(entry => (
            entry.speaker === segment.speaker
            && entry.normalizedText === normalizedText
            && Math.abs(entry.timestamp - segment.timestamp) <= DUPLICATE_TRANSCRIPT_WINDOW_MS
        ));
    }

    private rememberAcceptedTranscript(segment: TranscriptSegment): void {
        this.recentAcceptedTranscriptKeys.push({
            speaker: segment.speaker,
            normalizedText: this.normalizeTranscriptText(segment.text),
            timestamp: segment.timestamp,
        });

        if (this.recentAcceptedTranscriptKeys.length > 20) {
            this.recentAcceptedTranscriptKeys = this.recentAcceptedTranscriptKeys.slice(-20);
        }
    }

    private promoteBufferedInterviewerIfNeeded(incomingSegment: TranscriptSegment): void {
        if (!this.lastInterimInterviewer) {
            return;
        }

        const isIncomingInterviewerRevision = incomingSegment.speaker === 'interviewer'
            && Math.abs(incomingSegment.timestamp - this.lastInterimInterviewer.timestamp) <= PARTIAL_REVISION_WINDOW_MS
            && this.isLikelyInterviewerRevision(this.lastInterimInterviewer, incomingSegment);
        const debounceExpired = incomingSegment.timestamp - this.lastInterimInterviewer.timestamp >= consciousModeRealtimeConfig.transcriptDebounceMs;

        if (isIncomingInterviewerRevision || !debounceExpired) {
            return;
        }

        const promotedSegment: TranscriptSegment = {
            ...this.lastInterimInterviewer,
            final: true,
        };
        this.lastInterimInterviewer = null;

        if (this.shouldIgnoreTranscript(promotedSegment) || this.isDuplicateAcceptedTranscript(promotedSegment)) {
            return;
        }

        this.rememberAcceptedTranscript(promotedSegment);
        this.addTranscript(promotedSegment);
    }

    private isOverlappingSpeakerFailure(segment: TranscriptSegment): boolean {
        return (segment.marker ?? '').toLowerCase().includes('overlap');
    }

    private storeRawTranscriptSegment(segment: TranscriptSegment): void {
        if (this.isDuplicateAcceptedTranscript(segment)) {
            return;
        }

        this.rememberAcceptedTranscript(segment);
        this.fullTranscript.push(segment);
    }

    private isLikelyInterviewerRevision(previousSegment: TranscriptSegment, incomingSegment: TranscriptSegment): boolean {
        const previousText = this.normalizeTranscriptText(previousSegment.text);
        const incomingText = this.normalizeTranscriptText(incomingSegment.text);

        if (!previousText || !incomingText) {
            return false;
        }

        if (incomingText.startsWith(previousText) || previousText.startsWith(incomingText)) {
            return true;
        }

        const previousTokens = new Set(previousText.split(' '));
        const incomingTokens = incomingText.split(' ');
        const overlappingTokens = incomingTokens.filter(token => previousTokens.has(token)).length;
        const smallerTokenCount = Math.min(previousTokens.size, incomingTokens.length);

        return smallerTokenCount > 0 && (overlappingTokens / smallerTokenCount) >= 0.6;
    }

    /**
     * Compact transcript buffer by summarizing oldest entries into an epoch summary.
     * Called instead of raw slice() to preserve early meeting context.
     */
    private async compactTranscriptIfNeeded(): Promise<void> {
        if (this.fullTranscript.length <= 1800 || this.isCompacting) return;

        this.isCompacting = true;
        try {
            // Take the oldest 500 entries to summarize
            const summarizeCount = 500;
            const oldEntries = this.fullTranscript.slice(0, summarizeCount);
            const summaryInput = oldEntries.map(seg => {
                const role = this.mapSpeakerToRole(seg.speaker);
                const label = role === 'interviewer' ? 'INTERVIEWER' :
                    role === 'user' ? 'ME' : 'ASSISTANT';
                return `[${label}]: ${seg.text}`;
            }).join('\n');

            // Fire-and-forget LLM summarization (non-blocking)
            if (this.recapLLM) {
                try {
                    const epochSummary = await this.recapLLM.generate(
                        `Summarize this conversation segment into 3-5 concise bullet points preserving key topics, decisions, and questions:\n\n${summaryInput}`
                    );
                    if (epochSummary && epochSummary.trim().length > 0) {
                        this.transcriptEpochSummaries.push(epochSummary.trim());
                        console.log(`[SessionTracker] Epoch summary created (${this.transcriptEpochSummaries.length} total)`);
                    }
                } catch (e) {
                    // If summarization fails, store a simple marker
                    const fallback = `[Earlier discussion: ${oldEntries.length} segments, topics: ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                    this.transcriptEpochSummaries.push(fallback);
                    console.warn('[SessionTracker] Epoch summarization failed, using fallback marker');
                }
            }

            // Cap epoch summaries to prevent LLM context window overflow
            if (this.transcriptEpochSummaries.length > SessionTracker.MAX_EPOCH_SUMMARIES) {
                this.transcriptEpochSummaries = this.transcriptEpochSummaries.slice(-SessionTracker.MAX_EPOCH_SUMMARIES);
            }

            // Evict ONLY the exact 500 oldest entries that we just summarized
            this.fullTranscript = this.fullTranscript.slice(summarizeCount);
        } finally {
            this.isCompacting = false;
        }
    }
}
