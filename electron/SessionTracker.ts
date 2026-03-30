// SessionTracker.ts
// Manages session state, transcript arrays, context windows, and epoch compaction.
// Extracted from IntelligenceManager to decouple state management from LLM orchestration.

/** Maximum transcript entries before forced eviction (prevents memory exhaustion) */
const MAX_TRANSCRIPT_ENTRIES = 5000;

/** Maximum assistant response history entries */
const MAX_ASSISTANT_HISTORY = 100;

/** Maximum context history entries (beyond time-based eviction) */
const MAX_CONTEXT_HISTORY = 200;

/** Ring buffer for fixed-capacity context items */
class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(this.head + i) % this.capacity];
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

import { RecapLLM } from './llm';
import {
  ConsciousModeStructuredResponse,
  ReasoningThread,
  mergeConsciousModeResponses,
} from './ConsciousMode';
import { ThreadManager, InterviewPhaseDetector, TokenBudgetManager, InterviewPhase } from './conscious';
import { RESUME_THRESHOLD } from './conscious/types';
import { AdaptiveContextWindow, ContextEntry, ContextSelectionConfig } from './conscious/AdaptiveContextWindow';
import { isOptimizationActive } from './config/optimizations';

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

export interface MeetingMetadataSnapshot {
    title?: string;
    calendarEventId?: string;
    source?: 'manual' | 'calendar';
}

export interface MeetingSnapshot {
  transcript: TranscriptSegment[];
  usage: UsageInteraction[];
  startTime: number;
  durationMs: number;
  context: string;
  meetingMetadata: MeetingMetadataSnapshot | null;
}

export interface UsageInteraction {
  type: 'assist' | 'followup' | 'chat' | 'followup_questions';
  timestamp: number;
  question?: string;
  answer?: string;
  items?: string[];
}

export class SessionTracker {
  private static nextSessionId = 1;
  // Context management (mirrors Swift ContextManager)
  private contextItemsBuffer = new RingBuffer<ContextItem>(500);
  private readonly contextWindowDuration: number = 120; // 120 seconds
  private readonly maxContextItems: number = 500;
  
  private getContextItems(): ContextItem[] {
    return this.contextItemsBuffer.toArray();
  }

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
  private fullUsage: UsageInteraction[] = []; // UsageInteraction
  private sessionStartTime: number = Date.now();

    // Rolling summarization: epoch summaries preserve early context when arrays are compacted
    private static readonly MAX_EPOCH_SUMMARIES = 5;
    private transcriptEpochSummaries: string[] = [];
  private isCompacting: boolean = false;
  private pendingCompactionPromise: Promise<void> | null = null;
  private compactionTimer: NodeJS.Timeout | null = null;
  private readonly COMPACTION_IDLE_MS = 5000;
  private readonly COMPACTION_THRESHOLD = 2000;

  // Track interim interviewer segment
    private lastInterimInterviewer: TranscriptSegment | null = null;

    // Conscious Mode state
    private consciousModeEnabled: boolean = false;
    private latestConsciousResponse: ConsciousModeStructuredResponse | null = null;
    private activeReasoningThread: ReasoningThread | null = null;

    // Reference to RecapLLM for epoch summarization (injected later)
    private recapLLM: RecapLLM | null = null;

// Conscious Mode Realtime components
  private threadManager: ThreadManager = new ThreadManager();
  private phaseDetector: InterviewPhaseDetector = new InterviewPhaseDetector();
  private tokenBudgetManager: TokenBudgetManager = new TokenBudgetManager('openai');

  // Adaptive context window for acceleration
  private adaptiveContextWindow: AdaptiveContextWindow | null = null;
  private sessionId: string = `session_${SessionTracker.nextSessionId++}`;
  private transcriptRevision: number = 0;
  private compactSnapshotCache = new Map<string, { revision: number; value: string }>();

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
    const contextItems = this.getContextItems();
    const lastItem = contextItems[contextItems.length - 1];
    if (lastItem &&
      lastItem.role === role &&
      Math.abs(lastItem.timestamp - segment.timestamp) < 500 &&
      lastItem.text === text) {
      return null;
    }

    this.contextItemsBuffer.push({
      role,
      text,
      timestamp: segment.timestamp
    });
        this.transcriptRevision++;
        this.compactSnapshotCache.clear();

        this.evictOldEntries();

    // Filter out internal system prompts that might be passed via IPC
    const isInternalPrompt = text.startsWith("You are a real-time interview assistant") ||
      text.startsWith("You are a helper") ||
      text.startsWith("CONTEXT:");

    if (!isInternalPrompt) {
      // Add to session transcript
      this.fullTranscript.push(segment);

      // Hard cap to prevent memory exhaustion in very long meetings
      while (this.fullTranscript.length > MAX_TRANSCRIPT_ENTRIES) {
        this.fullTranscript.shift(); // Remove oldest entries
      }

      // Debounced compaction instead of immediate
      this.scheduleCompaction();
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

    this.contextItemsBuffer.push({
      role: 'assistant',
      text: cleanText,
      timestamp: Date.now()
    });
        this.transcriptRevision++;
        this.compactSnapshotCache.clear();

        // Also add to fullTranscript so it persists in the session history (and summaries)
        this.fullTranscript.push({
            speaker: 'assistant',
            text: cleanText,
            timestamp: Date.now(),
            final: true,
            confidence: 1.0
        });

        // Hard cap to prevent memory exhaustion in very long meetings
        while (this.fullTranscript.length > MAX_TRANSCRIPT_ENTRIES) {
            this.fullTranscript.shift(); // Remove oldest entries
        }

        this.scheduleCompaction();

        this.lastAssistantMessage = cleanText;

        // Temporal RAG: Track response history for anti-repetition
        this.assistantResponseHistory.push({
            text: cleanText,
            timestamp: Date.now(),
            questionContext: this.getLastInterviewerTurn() || 'unknown'
        });

        // Keep history bounded
        if (this.assistantResponseHistory.length > MAX_ASSISTANT_HISTORY) {
            this.assistantResponseHistory = this.assistantResponseHistory.slice(-MAX_ASSISTANT_HISTORY);
        }

        console.log(`[SessionTracker] lastAssistantMessage updated, history size: ${this.assistantResponseHistory.length}`);
        this.evictOldEntries();
    }

    /**
     * Handle incoming transcript from native audio service
     */
    handleTranscript(segment: TranscriptSegment): { role: 'interviewer' | 'user' | 'assistant' } | null {
        // Track interim segments for interviewer to prevent data loss on stop
        if (segment.speaker === 'interviewer') {
            if (Math.random() < 0.05 || segment.final) {
                console.log(`[SessionTracker] RX Interviewer Segment: Final=${segment.final} Text="${segment.text.substring(0, 50)}..."`);
            }

            if (!segment.final) {
                this.lastInterimInterviewer = segment;
            } else {
                this.lastInterimInterviewer = null;
            }
        }

        const result = this.addTranscript(segment);

        if (segment.final && segment.speaker === 'interviewer' && this.consciousModeEnabled) {
            this.updateConsciousConversationState(segment.text);
        }

        return result;
    }

    private updateConsciousConversationState(transcript: string): void {
        const normalized = transcript.trim();
        if (!normalized) {
            return;
        }

        const phase = this.detectPhaseFromTranscript(normalized);
        this.setCurrentPhase(phase);
        this.threadManager.pruneExpired();

        const activeThread = this.threadManager.getActiveThread();
        const matchingThread = this.threadManager.findMatchingThread(normalized, phase);

        if (!activeThread && matchingThread && matchingThread.confidence.total >= RESUME_THRESHOLD) {
            this.threadManager.resumeThread(matchingThread.thread.id);
        }

        const currentThread = this.threadManager.getActiveThread();
        const resumeKeywords = Array.from(new Set(
            normalized
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(word => word.length >= 4)
        ));

        if (!currentThread) {
            if (resumeKeywords.length > 0 || normalized.split(/\s+/).length >= 4) {
                this.threadManager.createThread(normalized, phase);
                this.threadManager.addKeywordsToActive(resumeKeywords);
            }
            return;
        }

        const phaseShift = currentThread.phase !== phase;
        const majorPhaseShift = phaseShift && (
            phase === 'behavioral_story' ||
            phase === 'wrap_up' ||
            currentThread.phase === 'behavioral_story'
        );

        if (majorPhaseShift) {
            this.threadManager.createThread(normalized, phase);
            this.threadManager.addKeywordsToActive(resumeKeywords);
            return;
        }

        this.threadManager.updateActiveThread({
            phase,
            turnCount: currentThread.turnCount + 1,
        });
        this.threadManager.addKeywordsToActive(resumeKeywords);
    }

    // ============================================
    // Context Accessors
    // ============================================

    /**
     * Get context items within the last N seconds
     */
    getContext(lastSeconds: number = 120): ContextItem[] {
        const cutoff = Date.now() - (lastSeconds * 1000);
        return this.getContextItems().filter((item: ContextItem) => item.timestamp >= cutoff);
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
        }
    }

isConsciousModeEnabled(): boolean {
    return this.consciousModeEnabled;
  }

  private getAdaptiveContextWindow(): AdaptiveContextWindow {
    if (!this.adaptiveContextWindow) {
      this.adaptiveContextWindow = new AdaptiveContextWindow();
    }
    return this.adaptiveContextWindow;
  }

  async getAdaptiveContext(
    query: string,
    queryEmbedding: number[],
    tokenBudget: number = 500
  ): Promise<ContextItem[]> {
    if (!isOptimizationActive('useAdaptiveWindow')) {
      return this.getContext(Math.floor(tokenBudget / 4));
    }

    const candidates: ContextEntry[] = this.getContextItems().map((item: ContextItem) => ({
      text: item.text,
      timestamp: item.timestamp,
      phase: undefined as InterviewPhase | undefined,
    }));

    const config: ContextSelectionConfig = {
      tokenBudget,
      recencyWeight: 0.4,
      semanticWeight: 0.4,
      phaseAlignmentWeight: 0.2,
    };

    const window = this.getAdaptiveContextWindow();
    const selected = await window.selectContext(query, queryEmbedding, candidates, config);

    return selected.map(entry => ({
      role: 'interviewer' as const,
      text: entry.text,
      timestamp: entry.timestamp,
    }));
  }

    getLatestConsciousResponse(): ConsciousModeStructuredResponse | null {
        return this.latestConsciousResponse;
    }

    getActiveReasoningThread(): ReasoningThread | null {
        return this.activeReasoningThread;
    }

    clearConsciousModeThread(): void {
        this.latestConsciousResponse = null;
        this.activeReasoningThread = null;
    }

    recordConsciousResponse(question: string, response: ConsciousModeStructuredResponse, threadAction: 'start' | 'continue' | 'reset'): void {
        this.latestConsciousResponse = response;

        if (threadAction === 'continue' && this.activeReasoningThread) {
            this.activeReasoningThread = {
                ...this.activeReasoningThread,
                lastQuestion: question,
                followUpCount: this.activeReasoningThread.followUpCount + 1,
                response: mergeConsciousModeResponses(this.activeReasoningThread.response, response),
                updatedAt: Date.now(),
            };
            this.latestConsciousResponse = this.activeReasoningThread.response;
            return;
        }

        this.activeReasoningThread = {
            rootQuestion: question,
            lastQuestion: question,
            response,
            followUpCount: 0,
            updatedAt: Date.now(),
        };
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

    getSessionId(): string {
        return this.sessionId;
    }

    getTranscriptRevision(): number {
        return this.transcriptRevision;
    }

    getCompactTranscriptSnapshot(maxTurns: number = 12, snapshotType: 'standard' | 'fast' = 'standard'): string {
        const cacheKey = `${this.sessionId}:${snapshotType}:${maxTurns}`;
        const cached = this.compactSnapshotCache.get(cacheKey);
        if (cached && cached.revision === this.transcriptRevision) {
            return cached.value;
        }

        const items = this.getContextItems().slice(-maxTurns);
        const snapshot = items.map(item => ({
            role: item.role,
            text: item.text,
            timestamp: item.timestamp,
        })).map(item => {
            const label = item.role === 'interviewer' ? 'INTERVIEWER' : item.role === 'assistant' ? 'ASSISTANT' : 'ME';
            return `[${label}]: ${item.text}`;
        }).join('\n');

        this.compactSnapshotCache.set(cacheKey, {
            revision: this.transcriptRevision,
            value: snapshot,
        });
        return snapshot;
    }

    /**
     * Get the last interviewer turn
     */
    getLastInterviewerTurn(): string | null {
    const contextItems = this.getContextItems();
    for (let i = contextItems.length - 1; i >= 0; i--) {
      if (contextItems[i].role === 'interviewer') {
        return contextItems[i].text;
            }
        }
        return null;
    }

    /**
     * Get full session context from accumulated transcript (User + Interviewer + Assistant)
     */
    getFullSessionContext(): string {
        return this.buildFullSessionContext(this.fullTranscript, this.transcriptEpochSummaries);
    }

    private buildFullSessionContext(transcript: TranscriptSegment[], epochSummaries: string[]): string {
        const recentTranscript = transcript.map(segment => {
            const role = this.mapSpeakerToRole(segment.speaker);
            const label = role === 'interviewer' ? 'INTERVIEWER' :
                role === 'user' ? 'ME' :
                    'ASSISTANT';
            return `[${label}]: ${segment.text}`;
        }).join('\n');

        if (epochSummaries.length > 0) {
            const epochContext = epochSummaries.join('\n---\n');
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

    getFullUsage(): UsageInteraction[] {
        return this.fullUsage;
    }

    createSuccessorSession(): SessionTracker {
        const next = new SessionTracker();
        next.setRecapLLM(this.recapLLM);
        next.setConsciousModeEnabled(this.consciousModeEnabled);
        return next;
    }

    getSessionStartTime(): number {
        return this.sessionStartTime;
    }

    createSnapshot(now: number = Date.now()): MeetingSnapshot {
        const transcript = this.fullTranscript.map(segment => ({ ...segment }));
        const epochSummaries = [...this.transcriptEpochSummaries];
        return {
            transcript,
            usage: this.fullUsage.map(entry => ({ ...entry })),
            startTime: this.sessionStartTime,
            durationMs: Math.max(0, now - this.sessionStartTime),
            context: this.buildFullSessionContext(transcript, epochSummaries),
            meetingMetadata: this.currentMeetingMetadata ? { ...this.currentMeetingMetadata } : null,
        };
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
  logUsage(type: UsageInteraction['type'], question: string, answer: string): void {
    this.fullUsage.push({
      type,
      timestamp: Date.now(),
      question,
      answer
    });
  }

  pushUsage(entry: UsageInteraction): void {
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
            this.addTranscript(finalSegment);
            this.lastInterimInterviewer = null;
        }
    }

    // ============================================
    // Conscious Mode Realtime Accessors
    // ============================================

    getThreadManager(): ThreadManager {
        return this.threadManager;
    }

    getPhaseDetector(): InterviewPhaseDetector {
        return this.phaseDetector;
    }

    getTokenBudgetManager(): TokenBudgetManager {
        return this.tokenBudgetManager;
    }

    getCurrentPhase(): InterviewPhase {
        return this.phaseDetector.getCurrentPhase();
    }

    setCurrentPhase(phase: InterviewPhase): void {
        this.phaseDetector.setPhase(phase);
    }

    detectPhaseFromTranscript(transcript: string): InterviewPhase {
        const result = this.phaseDetector.detectPhase(
            transcript,
            this.phaseDetector.getCurrentPhase(),
            this.getContextItems().slice(-5).map((item: ContextItem) => item.text)
        );
        return result.phase;
    }

    // ============================================
    // Reset
    // ============================================

  async reset(): Promise<void> {
    if (this.pendingCompactionPromise) {
      try {
        await this.pendingCompactionPromise;
      } catch {
        // Ignore compaction errors during reset
      }
    }

    this.cancelCompactionTimer();
    
    const consciousModeEnabled = this.consciousModeEnabled;
    
    const freshSessionId = `session_${SessionTracker.nextSessionId++}`;
    const freshStartTime = Date.now();
    
    this.contextItemsBuffer.clear();
    this.fullTranscript = [];
    this.fullUsage = [];
    this.currentMeetingMetadata = null;
    this.transcriptEpochSummaries = [];
    this.sessionStartTime = freshStartTime;
    this.lastAssistantMessage = null;
    this.assistantResponseHistory = [];
    this.lastInterimInterviewer = null;
    this.consciousModeEnabled = consciousModeEnabled;
    this.latestConsciousResponse = null;
    this.activeReasoningThread = null;
    this.threadManager.reset();
    this.phaseDetector.reset();
    this.tokenBudgetManager.reset();
    this.adaptiveContextWindow = null;
    this.transcriptRevision = 0;
    this.compactSnapshotCache.clear();
    this.sessionId = freshSessionId;
    
    this.pendingCompactionPromise = null;
    this.isCompacting = false;
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
    // Ring buffer automatically handles capacity
    // Time-based eviction handled by callers via getContextItems()
  }

  /**
   * Schedule debounced compaction. Triggers immediately if threshold exceeded,
   * otherwise waits for idle period.
   */
  private scheduleCompaction(): void {
    if (this.fullTranscript.length > this.COMPACTION_THRESHOLD) {
      this.cancelCompactionTimer();
      void this.compactTranscriptIfNeeded().catch(e =>
        console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
      );
      return;
    }

    if (this.compactionTimer) {
      clearTimeout(this.compactionTimer);
    }

    this.compactionTimer = setTimeout(() => {
      this.compactionTimer = null;
      void this.compactTranscriptIfNeeded().catch(e =>
        console.warn('[SessionTracker] compactTranscript error (non-fatal):', e)
      );
    }, this.COMPACTION_IDLE_MS);
  }

  private cancelCompactionTimer(): void {
    if (this.compactionTimer) {
      clearTimeout(this.compactionTimer);
      this.compactionTimer = null;
    }
  }

  /**
   * Compact transcript buffer by summarizing oldest entries into an epoch summary.
   * Called instead of raw slice() to preserve early meeting context.
   */
  private async compactTranscriptIfNeeded(): Promise<void> {
    if (this.fullTranscript.length <= 1800 || this.isCompacting) return;

    this.isCompacting = true;
    const promise = (async () => {
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
        } catch (error) {
            console.error('[SessionTracker] Error during transcript compaction:', error);
            // Continue with compaction even if summarization fails
            try {
                // Fallback: create a simple marker without LLM summarization
                const oldEntries = this.fullTranscript.slice(0, 500);
                const fallback = `[Earlier discussion: ${oldEntries.length} segments, topics: ${oldEntries.slice(0, 3).map(s => s.text.substring(0, 40)).join('; ')}...]`;
                this.transcriptEpochSummaries.push(fallback);
                this.transcriptEpochSummaries = this.transcriptEpochSummaries.slice(-SessionTracker.MAX_EPOCH_SUMMARIES);
                this.fullTranscript = this.fullTranscript.slice(500);
                console.warn('[SessionTracker] Using fallback compaction due to error');
            } catch (fallbackError) {
                console.error('[SessionTracker] Fallback compaction also failed:', fallbackError);
            }
    } finally {
      this.isCompacting = false;
    }
    })();
    this.pendingCompactionPromise = promise;
    return promise;
  }
}
