// SessionTracker.ts
// Manages session state, transcript arrays, context windows, and epoch compaction.
// Extracted from IntelligenceManager to decouple state management from LLM orchestration.

import { RecapLLM } from './llm';
import { Result, LLMError } from './types/Result';
import {
  ConsciousModeStructuredResponse,
  ReasoningThread,
} from './ConsciousMode';
import {
  ThreadManager,
  InterviewPhaseDetector,
  TokenBudgetManager,
  InterviewPhase,
  ConsciousThreadStore,
  ThreadDirector,
  isNativelyThreadDirectorEnabled,
  DesignStateStore,
  ObservedQuestionStore,
  QuestionReactionClassifier,
  AnswerHypothesisStore,
  ConsciousResponsePreferenceStore,
  type ConsciousPlannerPreferenceSummary,
  type ConsciousResponseQuestionMode,
} from './conscious';
import { AdaptiveContextWindow } from './conscious/AdaptiveContextWindow';
import { extractConstraints, ExtractedConstraint, ResponseFingerprinter } from './conscious';
import { SessionPersistence } from './memory/SessionPersistence';
import { TokenCounter } from './shared/TokenCounter';
import { getActiveAccelerationManager } from './services/AccelerationManager';
import type { RuntimeBudgetScheduler } from './runtime/RuntimeBudgetScheduler';
import type { SupervisorEvent } from './runtime/types';

import {
  MAX_TRANSCRIPT_ENTRIES,
  MAX_ASSISTANT_HISTORY,
  RingBuffer,
  type SupervisorBusEmitter,
  type TranscriptSegment,
  type SuggestionTrigger,
  type ContextItem,
  type AssistantResponse,
  type PinnedItem,
  type MeetingMetadataSnapshot,
  type MeetingSnapshot,
  type UsageInteraction,
  mapSpeakerToRole as mapSpeakerToRoleImpl,
} from './session/sessionTypes';

// Re-export types so existing consumers don't break
export type {
  TranscriptSegment,
  SuggestionTrigger,
  ContextItem,
  AssistantResponse,
  PinnedItem,
  MeetingMetadataSnapshot,
  MeetingSnapshot,
  UsageInteraction,
};

import {
  buildPinnedContextSection,
  buildPseudoEmbedding,
  inferItemPhase,
  getFormattedContext,
  getCompactTranscriptSnapshot,
  buildFullSessionContext,
  getAdaptiveContext,
  getConsciousRelevantContext,
  getConsciousLongMemoryContext,
} from './session/sessionContext';

import {
  createSessionDisposedError,
  rejectPendingWorkOnDispose,
  getHotState,
  getWarmState,
  getColdState,
  persistState,
  appendTranscriptEvent,
  restoreFromMeetingId,
  ensureMeetingContext,
  flushPersistenceNow,
  appendSessionEvent,
} from './session/sessionPersistence';
import type { SessionEvent } from './memory/SessionPersistence';

function resolveClassifierLane(): Pick<RuntimeBudgetScheduler, 'submit'> | undefined {
  return getActiveAccelerationManager()?.getRuntimeBudgetScheduler();
}

export class SessionTracker {
  private static nextSessionId = 1;
  private isRestoring = false;
  private writeBuffer: Array<() => void> = [];
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
  private consciousSemanticContext: string = '';

  // Reference to RecapLLM for epoch summarization (injected later)
  private recapLLM: RecapLLM | null = null;

  // Conscious Mode Realtime components
  private consciousThreadStore: ConsciousThreadStore = new ConsciousThreadStore();
  private threadDirector: ThreadDirector | null = isNativelyThreadDirectorEnabled()
    ? new ThreadDirector(this.consciousThreadStore)
    : null;
  private observedQuestionStore: ObservedQuestionStore = new ObservedQuestionStore();
  private questionReactionClassifier: QuestionReactionClassifier = new QuestionReactionClassifier();
  private answerHypothesisStore: AnswerHypothesisStore = new AnswerHypothesisStore();
  private responsePreferenceStore: ConsciousResponsePreferenceStore = new ConsciousResponsePreferenceStore();
  private designStateStore: DesignStateStore = new DesignStateStore();
  private phaseDetector: InterviewPhaseDetector = new InterviewPhaseDetector({
    classifierLane: resolveClassifierLane(),
  });
  private tokenBudgetManager: TokenBudgetManager = new TokenBudgetManager('openai');

  // Adaptive context window for acceleration
  private adaptiveContextWindow: AdaptiveContextWindow | null = null;
  private sessionId: string = `session_${SessionTracker.nextSessionId++}`;
  private transcriptRevision: number = 0;
  private utteranceRevisions = new Map<string, number>();
  private compactSnapshotCache = new Map<string, { revision: number; value: string }>();
  private readonly persistence = new SessionPersistence();
  private pendingRestorePromise: Promise<void> | null = null;
  private restoreRequestId: number = 0;
  private activeMeetingId: string = 'unspecified';
  private pinnedItems: PinnedItem[] = [];
  private readonly maxPinnedItems: number = 10;
  private extractedConstraints: ExtractedConstraint[] = [];
  private readonly fingerprinter: ResponseFingerprinter = new ResponseFingerprinter();
  private readonly contextAssembleCache = new Map<string, { assembled: string; tokenCount: number; revision: number; createdAt: number }>();
  private readonly contextCacheTTLms = 10000;
  private readonly contextCacheMaxEntries = 20;
  private readonly tokenCounter: TokenCounter = new TokenCounter('openai');
  private readonly semanticEmbeddingCache = new Map<string, { embedding: number[]; createdAt: number }>();
  private readonly semanticEmbeddingTTLms = 5 * 60 * 1000;
  private supervisorBus?: SupervisorBusEmitter;
  private eventCount = 0;
  private readonly EVENT_SNAPSHOT_INTERVAL = 1000;
  private adaptiveWindowStats = {
    calls: 0,
    totalMs: 0,
    over50ms: 0,
    timeouts: 0,
  };
  private readonly ADAPTIVE_WINDOW_TIMEOUT_MS = 300;
  private readonly ADAPTIVE_QUERY_MAX_LEN = 220;
  private disposed = false;

  // ============================================
  // Configuration
  // ============================================

  public setRecapLLM(recapLLM: RecapLLM | null): void {
    this.recapLLM = recapLLM;
  }

  public setMeetingMetadata(metadata: any): void {
    this.currentMeetingMetadata = metadata;
    const inferredMeetingId = metadata?.meetingId || metadata?.calendarEventId || metadata?.title;
    if (typeof inferredMeetingId === 'string' && inferredMeetingId.trim()) {
      const normalizedMeetingId = inferredMeetingId.trim();
      if (normalizedMeetingId !== this.activeMeetingId) {
        return;
      }
      this.activeMeetingId = normalizedMeetingId;
    }
    persistState(this);
  }

  getActiveMeetingId(): string {
    return this.activeMeetingId;
  }

  setSupervisorBus(bus?: SupervisorBusEmitter): void {
    this.supervisorBus = bus;
  }

  private emitSupervisorEvent(event: SupervisorEvent): void {
    if (this.disposed) {
      return;
    }
    void this.supervisorBus?.emit(event).catch((error) => {
      console.warn(`[SessionTracker] Failed to emit supervisor event ${event.type}:`, error);
    });
  }

  noteUtteranceRevision(utteranceId: string | undefined): void {
    if (!utteranceId) return;
    this.utteranceRevisions.set(utteranceId, (this.utteranceRevisions.get(utteranceId) ?? 0) + 1);
  }

  public getMeetingMetadata() {
    return this.currentMeetingMetadata;
  }

  public clearMeetingMetadata(): void {
    this.currentMeetingMetadata = null;
    persistState(this);
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
    if (this.disposed) {
      return null;
    }
    if (!segment.final) return null;

    if (this.isRestoring) {
      const capturedSegment = { ...segment };
      let bufferedResult: { role: 'interviewer' | 'user' | 'assistant' } | null = null;
      this.writeBuffer.push(() => {
        bufferedResult = this.addTranscript(capturedSegment);
      });
      const role = mapSpeakerToRoleImpl(segment.speaker);
      return role ? { role } : null;
    }

    const role = mapSpeakerToRoleImpl(segment.speaker);
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

    // Consolidate: append to last item if same speaker within 300ms.
    // This merges rapid transcript fragments without combining distinct turns.
    if (lastItem &&
      lastItem.role === role &&
      Math.abs(lastItem.timestamp - segment.timestamp) < 300) {
      const consolidatedText = `${lastItem.text} ${text}`;
      lastItem.text = consolidatedText;
      lastItem.embedding = buildPseudoEmbedding(consolidatedText);
      this.transcriptRevision++;
      this.noteUtteranceRevision(segment.utteranceId);
      this.compactSnapshotCache.clear();
      this.contextAssembleCache.clear();
      return { role };
    }

    const itemPhase = inferItemPhase(this, role, text);
    this.contextItemsBuffer.push({
      role,
      text,
      timestamp: segment.timestamp,
      phase: itemPhase,
      embedding: buildPseudoEmbedding(text),
    });
    this.transcriptRevision++;
    this.noteUtteranceRevision(segment.utteranceId);
    this.compactSnapshotCache.clear();
    this.contextAssembleCache.clear();

    // Extract and auto-pin constraints from interviewer/user turns only
    if (this.shouldRunConstraintExtraction(role)) {
      const constraints = extractConstraints(text);
      if (constraints.length > 0) {
        for (const constraint of constraints) {
          if (!this.hasConstraint(constraint.normalized)) {
            this.extractedConstraints.push(constraint);
            this.pinItem(constraint.normalized, constraint.type, true);
          }
        }
      }
    }

    this.evictOldEntries();

    // Filter out internal system prompts that might be passed via IPC
    const isInternalPrompt = text.startsWith("You are a real-time interview assistant") ||
      text.startsWith("You are a helper") ||
      text.startsWith("CONTEXT:");

    if (!isInternalPrompt) {
      // Add to session transcript
      this.fullTranscript.push(segment);

      if (this.fullTranscript.length > MAX_TRANSCRIPT_ENTRIES) {
        this.fullTranscript.splice(0, this.fullTranscript.length - MAX_TRANSCRIPT_ENTRIES);
      }

      // Debounced compaction instead of immediate
      this.scheduleCompaction();

      // NAT-059: append event to event-sourced log
      appendTranscriptEvent(this, segment).catch((err) => {
        console.warn('[SessionTracker] Event append failed:', err);
      });
    }

    persistState(this);

    return { role };
  }

  /**
   * Add assistant-generated message to context
   */
  addAssistantMessage(text: string): void {
    if (this.disposed) {
      return;
    }
    console.log(`[SessionTracker] addAssistantMessage called with:`, text.substring(0, 50));

    if (this.isRestoring) {
      const capturedText = text;
      this.writeBuffer.push(() => {
        this.addAssistantMessage(capturedText);
      });
      return;
    }

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
      timestamp: Date.now(),
      phase: this.phaseDetector.getCurrentPhase(),
      embedding: buildPseudoEmbedding(cleanText),
    });
    this.transcriptRevision++;
    this.compactSnapshotCache.clear();
    this.contextAssembleCache.clear();

    if (this.fingerprinter.isDuplicate(cleanText).isDupe) {
      console.warn('[SessionTracker] Duplicate assistant response detected by fingerprint history');
    }
    this.fingerprinter.record(cleanText);

    // Also add to fullTranscript so it persists in the session history (and summaries)
    this.fullTranscript.push({
      speaker: 'assistant',
      text: cleanText,
      timestamp: Date.now(),
      final: true,
      confidence: 1.0
    });

    // Hard cap to prevent memory exhaustion in very long meetings
    if (this.fullTranscript.length > MAX_TRANSCRIPT_ENTRIES) {
      this.fullTranscript.splice(0, this.fullTranscript.length - MAX_TRANSCRIPT_ENTRIES);
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
    persistState(this);
  }

  /**
   * Handle incoming transcript from native audio service
   */
  handleTranscript(segment: TranscriptSegment): { role: 'interviewer' | 'user' | 'assistant' } | null {
    if (this.disposed) {
      return null;
    }
    if (this.isRestoring) {
      const capturedSegment = { ...segment };
      this.writeBuffer.push(() => {
        this.handleTranscript(capturedSegment);
      });
      const role = mapSpeakerToRoleImpl(segment.speaker);
      return role ? { role } : null;
    }

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

    if (segment.final && segment.speaker === 'interviewer') {
      this.observedQuestionStore.noteQuestion(segment.text, segment.timestamp);
      if (this.consciousModeEnabled) {
        const reaction = this.questionReactionClassifier.classify({
          question: segment.text,
          activeThread: this.consciousThreadStore.getActiveReasoningThread(),
          latestResponse: this.consciousThreadStore.getLatestConsciousResponse(),
          latestHypothesis: this.answerHypothesisStore.getLatestHypothesis(),
        });
        this.answerHypothesisStore.noteObservedReaction(segment.text, reaction);
      }
    }

    if (segment.final && segment.speaker === 'interviewer' && this.consciousModeEnabled) {
      this.updateConsciousConversationState(segment.text);
    }

    if (segment.final && segment.speaker === 'user' && this.consciousModeEnabled) {
      const changed = this.responsePreferenceStore.noteUserTranscript(segment.text, segment.timestamp);
      if (changed) {
        persistState(this);
      }
    }

    if (segment.final && this.consciousModeEnabled && (segment.speaker === 'interviewer' || segment.speaker === 'user')) {
      this.designStateStore.noteInterviewerTurn({
        transcript: segment.text,
        timestamp: segment.timestamp,
        phase: this.phaseDetector.getCurrentPhase(),
        constraints: extractConstraints(segment.text),
      });
    }

    return result;
  }

  private updateConsciousConversationState(transcript: string): void {
    const detect = (value: string) => this.detectPhaseFromTranscript(value);
    const setPhase = (phase: InterviewPhase) => this.phaseDetector.setPhase(phase);
    if (this.threadDirector) {
      this.threadDirector.handleObservedInterviewerTranscript(transcript, detect, setPhase);
    } else {
      this.consciousThreadStore.handleObservedInterviewerTranscript(transcript, detect, setPhase);
    }
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
      this.consciousThreadStore.reset();
      this.observedQuestionStore.reset();
      this.answerHypothesisStore.reset();
      this.responsePreferenceStore.reset();
      this.designStateStore.reset();
      this.consciousSemanticContext = '';
      persistState(this);
    }
  }

  isConsciousModeEnabled(): boolean {
    return this.consciousModeEnabled;
  }

  isLikelyGeneralIntent(lastInterviewerTurn: string | null): boolean {
    return this.observedQuestionStore.isLikelyGeneralIntent(lastInterviewerTurn);
  }

  // ============================================
  // Conscious Mode Accessors
  // ============================================

  getLatestConsciousResponse(): ConsciousModeStructuredResponse | null {
    return this.consciousThreadStore.getLatestConsciousResponse();
  }

  getActiveReasoningThread(): ReasoningThread | null {
    return this.consciousThreadStore.getActiveReasoningThread();
  }

  clearConsciousModeThread(): void {
    if (this.threadDirector) {
      this.threadDirector.resetThread('clear_conscious_mode');
    } else {
      this.consciousThreadStore.reset();
    }
    this.answerHypothesisStore.reset();
    this.responsePreferenceStore.reset();
    this.designStateStore.reset();
    persistState(this);
  }

  recordConsciousResponse(question: string, response: ConsciousModeStructuredResponse, threadAction: 'start' | 'continue' | 'reset'): void {
    if (this.threadDirector) {
      this.threadDirector.recordConsciousResponse(question, response, threadAction);
    } else {
      this.consciousThreadStore.recordConsciousResponse(question, response, threadAction);
    }
    this.answerHypothesisStore.recordStructuredSuggestion(question, response, threadAction);
    this.designStateStore.noteStructuredResponse({
      question,
      response,
      timestamp: Date.now(),
      phase: this.phaseDetector.getCurrentPhase(),
    });
    const activeThread = this.consciousThreadStore.getThreadManager().getActiveThread();
    this.emitSupervisorEvent({
      type: 'conscious:thread_action',
      action: threadAction,
      question,
      phase: this.phaseDetector.getCurrentPhase(),
      threadId: activeThread?.id ?? null,
      topic: activeThread?.topic ?? null,
    });
    void this.recordSessionEvent('conscious_thread_action', {
      action: threadAction,
      question,
      phase: this.phaseDetector.getCurrentPhase(),
      threadId: activeThread?.id ?? null,
      topic: activeThread?.topic ?? null,
    });
  }

  getLatestQuestionReaction() {
    return this.answerHypothesisStore.getLatestReaction();
  }

  getLatestAnswerHypothesis() {
    return this.answerHypothesisStore.getLatestHypothesis();
  }

  getConsciousEvidenceContext(): string {
    return this.answerHypothesisStore.buildContextBlock();
  }

  getConsciousResponsePreferenceContext(questionMode: ConsciousResponseQuestionMode): string {
    return this.responsePreferenceStore.buildContextBlock(questionMode);
  }

  getConsciousResponsePreferenceSummary(questionMode: ConsciousResponseQuestionMode): ConsciousPlannerPreferenceSummary {
    return this.responsePreferenceStore.getPlannerPreferenceSummary(questionMode);
  }

  setConsciousSemanticContext(block: string): void {
    this.consciousSemanticContext = block || '';
  }

  getConsciousSemanticContext(): string {
    return this.consciousSemanticContext;
  }

  getConsciousLongMemoryContext(query: string): string {
    return getConsciousLongMemoryContext(this, query);
  }

  // ============================================
  // Formatted Context
  // ============================================

  getFormattedContext(lastSeconds: number = 120): string {
    return getFormattedContext(this, lastSeconds);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTranscriptRevision(): number {
    return this.transcriptRevision;
  }

  getUtteranceRevision(utteranceId: string | null | undefined): number | undefined {
    if (!utteranceId) return undefined;
    return this.utteranceRevisions.get(utteranceId);
  }

  getCompactTranscriptSnapshot(maxTurns: number = 12, snapshotType: 'standard' | 'fast' = 'standard'): string {
    return getCompactTranscriptSnapshot(this, maxTurns, snapshotType);
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
    return buildFullSessionContext(this.fullTranscript, this.transcriptEpochSummaries);
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

  getHotState(now: number = Date.now()): import('./memory/SessionPersistence').PersistedSessionMemoryEntry[] {
    return getHotState(this, now);
  }

  getWarmState(now: number = Date.now()): import('./memory/SessionPersistence').PersistedSessionMemoryEntry[] {
    return getWarmState(this, now);
  }

  getColdState(now: number = Date.now()): import('./memory/SessionPersistence').PersistedSessionMemoryEntry[] {
    return getColdState(this, now);
  }

  createSuccessorSession(): SessionTracker {
    const next = new SessionTracker();
    next.setRecapLLM(this.recapLLM);
    next.setConsciousModeEnabled(this.consciousModeEnabled);
    next.setSupervisorBus(this.supervisorBus);
    return next;
  }

  getPinnedItems(): PinnedItem[] {
    return [...this.pinnedItems];
  }

  pinItem(text: string, label?: string, skipPersist: boolean = false): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (this.pinnedItems.length >= this.maxPinnedItems) {
      this.pinnedItems.shift();
    }

    this.pinnedItems.push({
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: trimmed,
      pinnedAt: Date.now(),
      label,
    });
    this.designStateStore.notePinnedItem(trimmed, label, Date.now(), this.phaseDetector.getCurrentPhase());
    this.contextAssembleCache.clear();

    if (!skipPersist) {
      persistState(this);
    }
  }

  unpinItem(id: string): void {
    this.pinnedItems = this.pinnedItems.filter((item) => item.id !== id);
    this.contextAssembleCache.clear();
    persistState(this);
  }

  clearPinnedItems(): void {
    this.pinnedItems = [];
    this.contextAssembleCache.clear();
    persistState(this);
  }

  hasConstraint(normalized: string): boolean {
    const key = normalized.trim().toLowerCase();
    return this.extractedConstraints.some((constraint) => constraint.normalized.toLowerCase() === key);
  }

  getConstraintSummary(): ExtractedConstraint[] {
    return [...this.extractedConstraints];
  }

  getAdaptiveWindowStats(): { calls: number; avgMs: number; over50ms: number; timeouts: number } {
    const avgMs = this.adaptiveWindowStats.calls > 0
      ? this.adaptiveWindowStats.totalMs / this.adaptiveWindowStats.calls
      : 0;
    return {
      calls: this.adaptiveWindowStats.calls,
      avgMs,
      over50ms: this.adaptiveWindowStats.over50ms,
      timeouts: this.adaptiveWindowStats.timeouts,
    };
  }

  setActiveMeetingId(meetingId: string): void {
    if (!meetingId.trim()) return;
    this.activeMeetingId = meetingId.trim();
    persistState(this);
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
      context: buildFullSessionContext(transcript, epochSummaries),
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
    return this.consciousThreadStore.getThreadManager();
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

  setCurrentPhase(phase: InterviewPhase, trigger: 'interviewer_transcript' | 'manual' = 'manual'): void {
    const currentPhase = this.phaseDetector.getCurrentPhase();
    this.phaseDetector.setPhase(phase);
    if (currentPhase !== phase) {
      this.emitSupervisorEvent({
        type: 'conscious:phase_changed',
        from: currentPhase,
        to: phase,
        trigger,
      });
    }
  }

  detectPhaseFromTranscript(transcript: string): InterviewPhase {
    const previousPhase = this.phaseDetector.getCurrentPhase();
    const result = this.phaseDetector.detectPhase(
      transcript,
      this.phaseDetector.getCurrentPhase(),
      this.getContextItems().slice(-5).map((item: ContextItem) => item.text)
    );
    if (previousPhase !== result.phase) {
      this.emitSupervisorEvent({
        type: 'conscious:phase_changed',
        from: previousPhase,
        to: result.phase,
        trigger: 'interviewer_transcript',
      });
    }
    return result.phase;
  }

  // ============================================
  // Reset
  // ============================================

  async reset(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.pendingCompactionPromise) {
      try {
        await this.pendingCompactionPromise;
      } catch {
        // Ignore compaction errors during reset
      }
    }

    this.cancelCompactionTimer();

    const consciousModeEnabled = this.consciousModeEnabled;
    const previousMeetingId = this.activeMeetingId;

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
    this.consciousThreadStore.reset();
    this.observedQuestionStore.reset();
    this.answerHypothesisStore.reset();
    this.responsePreferenceStore.reset();
    this.designStateStore.reset();
    this.consciousSemanticContext = '';
    this.phaseDetector.reset();
    this.tokenBudgetManager.reset();
    this.adaptiveContextWindow = null;
    this.transcriptRevision = 0;
    this.utteranceRevisions.clear();
    this.compactSnapshotCache.clear();
    this.contextAssembleCache.clear();
    this.semanticEmbeddingCache.clear();
    this.sessionId = freshSessionId;
    this.pinnedItems = [];
    this.extractedConstraints = [];
    this.fingerprinter.clear();
    this.adaptiveWindowStats = {
      calls: 0,
      totalMs: 0,
      over50ms: 0,
      timeouts: 0,
    };

    if (previousMeetingId && previousMeetingId !== 'unspecified') {
      this.activeMeetingId = previousMeetingId;
      persistState(this);
      try {
        await this.persistence.flushScheduledSave();
      } catch {
        // Ignore persistence flush errors during reset; the in-memory state is already clear.
      }
    }

    this.pendingCompactionPromise = null;
    this.isCompacting = false;
    this.activeMeetingId = 'unspecified';
    this.pendingRestorePromise = null;
    this.restoreRequestId = 0;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cancelCompactionTimer();
    rejectPendingWorkOnDispose(this);

    await flushPersistenceNow(this);
  }

  // ============================================
  // Public mapSpeakerToRole (preserved API)
  // ============================================

  mapSpeakerToRole(speaker: string): 'interviewer' | 'user' | 'assistant' {
    return mapSpeakerToRoleImpl(speaker);
  }

  // ============================================
  // Private Helpers
  // ============================================

  private shouldRunConstraintExtraction(role: ContextItem['role']): boolean {
    return role === 'interviewer' || role === 'user';
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
    if (this.disposed) {
      throw createSessionDisposedError();
    }
    if (this.fullTranscript.length <= 1800 || this.isCompacting) return;

    this.isCompacting = true;
    const promise = (async () => {
      try {
        // Take the oldest 500 entries to summarize
        const summarizeCount = 500;
        const oldEntries = this.fullTranscript.slice(0, summarizeCount);
        const summaryInput = oldEntries.map(seg => {
          const role = mapSpeakerToRoleImpl(seg.speaker);
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
            if (epochSummary.success && epochSummary.data.trim().length > 0) {
              this.transcriptEpochSummaries.push(epochSummary.data.trim());
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

  // ============================================
  // Persistence (delegated to sessionPersistence)
  // ============================================

  async restoreFromMeetingId(meetingId: string, requestId: number = this.restoreRequestId): Promise<boolean> {
    return restoreFromMeetingId(this, meetingId, requestId);
  }

  ensureMeetingContext(meetingId?: string): void {
    ensureMeetingContext(this, meetingId);
  }

  async waitForPendingRestore(): Promise<void> {
    if (this.pendingRestorePromise) {
      await this.pendingRestorePromise;
    }
  }

  async flushPersistenceNow(): Promise<void> {
    await flushPersistenceNow(this);
  }

  async recordSessionEvent(
    type: SessionEvent['type'],
    payload: Record<string, unknown>,
    timestamp: number = Date.now(),
  ): Promise<void> {
    try {
      await appendSessionEvent(this, type, payload, timestamp);
    } catch (error) {
      console.warn('[SessionTracker] Failed to append session event:', error);
    }
  }

  // ============================================
  // Adaptive Context (delegated to sessionContext)
  // ============================================

  async getAdaptiveContext(
    query: string,
    queryEmbedding: number[],
    tokenBudget: number = 500
  ): Promise<ContextItem[]> {
    return getAdaptiveContext(this, query, queryEmbedding, tokenBudget);
  }

  async getConsciousRelevantContext(query: string, tokenBudget: number = 900): Promise<ContextItem[]> {
    return getConsciousRelevantContext(this, query, tokenBudget);
  }
}
