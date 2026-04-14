// SessionTracker.ts
// Manages session state, transcript arrays, context windows, and epoch compaction.
// Extracted from IntelligenceManager to decouple state management from LLM orchestration.

/** Maximum transcript entries before forced eviction (prevents memory exhaustion) */
const MAX_TRANSCRIPT_ENTRIES = 5000;

/** Maximum assistant response history entries */
const MAX_ASSISTANT_HISTORY = 100;

/** Maximum context history entries (beyond time-based eviction) */
const MAX_CONTEXT_HISTORY = 200;

const HOT_MEMORY_WINDOW_MS = 60_000;
const HOT_MEMORY_CEILING_BYTES = 50 * 1024 * 1024;
const WARM_MEMORY_CEILING_BYTES = 100 * 1024 * 1024;

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
} from './ConsciousMode';
import {
  ThreadManager,
  InterviewPhaseDetector,
  TokenBudgetManager,
  InterviewPhase,
  ConsciousThreadStore,
  DesignStateStore,
  ObservedQuestionStore,
  QuestionReactionClassifier,
  AnswerHypothesisStore,
} from './conscious';
import { AdaptiveContextWindow, ContextEntry, ContextSelectionConfig } from './conscious/AdaptiveContextWindow';
import { getEmbeddingProvider } from './cache/ParallelContextAssembler';
import { isOptimizationActive } from './config/optimizations';
import { extractConstraints, ExtractedConstraint, detectQuestion, ResponseFingerprinter } from './conscious';
import {
  SessionPersistence,
  PersistedSession,
  PersistedSessionMemoryEntry,
  PersistedSessionMemoryEntryValue,
  PersistedSessionMemoryState,
} from './memory/SessionPersistence';
import { TokenCounter } from './shared/TokenCounter';
import { getActiveAccelerationManager } from './services/AccelerationManager';
import type { RuntimeBudgetScheduler } from './runtime/RuntimeBudgetScheduler';

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
    phase?: InterviewPhase;
    embedding?: number[];
}

export interface AssistantResponse {
    text: string;
    timestamp: number;
    questionContext: string;
}

export interface PinnedItem {
  id: string;
  text: string;
  pinnedAt: number;
  label?: string;
}

function resolveClassifierLane(): Pick<RuntimeBudgetScheduler, 'submit'> | undefined {
  return getActiveAccelerationManager()?.getRuntimeBudgetScheduler();
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
    private consciousSemanticContext: string = '';

    // Reference to RecapLLM for epoch summarization (injected later)
    private recapLLM: RecapLLM | null = null;

// Conscious Mode Realtime components
  private consciousThreadStore: ConsciousThreadStore = new ConsciousThreadStore();
  private observedQuestionStore: ObservedQuestionStore = new ObservedQuestionStore();
  private questionReactionClassifier: QuestionReactionClassifier = new QuestionReactionClassifier();
  private answerHypothesisStore: AnswerHypothesisStore = new AnswerHypothesisStore();
  private designStateStore: DesignStateStore = new DesignStateStore();
  private phaseDetector: InterviewPhaseDetector = new InterviewPhaseDetector({
    classifierLane: resolveClassifierLane(),
  });
  private tokenBudgetManager: TokenBudgetManager = new TokenBudgetManager('openai');

  // Adaptive context window for acceleration
  private adaptiveContextWindow: AdaptiveContextWindow | null = null;
  private sessionId: string = `session_${SessionTracker.nextSessionId++}`;
  private transcriptRevision: number = 0;
  private compactSnapshotCache = new Map<string, { revision: number; value: string }>();
  private readonly persistence: SessionPersistence = new SessionPersistence();
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
  private readonly semanticEmbeddingCacheMaxSize = 100;
  private adaptiveWindowStats = {
    calls: 0,
    totalMs: 0,
    over50ms: 0,
    timeouts: 0,
  };
  private readonly ADAPTIVE_WINDOW_TIMEOUT_MS = 120;
  private readonly ADAPTIVE_QUERY_MAX_LEN = 220;

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
          this.activeMeetingId = inferredMeetingId.trim();
        }
        this.persistState();
    }

    public getMeetingMetadata() {
        return this.currentMeetingMetadata;
    }

    public clearMeetingMetadata(): void {
        this.currentMeetingMetadata = null;
        this.persistState();
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

    const itemPhase = this.inferItemPhase(role, text);
    this.contextItemsBuffer.push({
      role,
      text,
      timestamp: segment.timestamp,
      phase: itemPhase,
      embedding: this.buildPseudoEmbedding(text),
    });
        this.transcriptRevision++;
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

      // Hard cap to prevent memory exhaustion in very long meetings
      while (this.fullTranscript.length > MAX_TRANSCRIPT_ENTRIES) {
        this.fullTranscript.shift(); // Remove oldest entries
      }

      // Debounced compaction instead of immediate
      this.scheduleCompaction();
    }

        this.persistState();

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
      timestamp: Date.now(),
      phase: this.phaseDetector.getCurrentPhase(),
      embedding: this.buildPseudoEmbedding(cleanText),
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
        this.persistState();
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
        this.consciousThreadStore.handleObservedInterviewerTranscript(
            transcript,
            (value) => this.detectPhaseFromTranscript(value),
            (phase) => this.setCurrentPhase(phase)
        );
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
            this.answerHypothesisStore.reset();
            this.designStateStore.reset();
            this.consciousSemanticContext = '';
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private buildPinnedContextSection(): string {
    if (this.pinnedItems.length === 0) return '';
    const rows = this.pinnedItems
      .map((item) => item.label ? `[${item.label}] ${item.text}` : item.text)
      .join('\n');
    return `<pinned_context>\n${rows}\n</pinned_context>`;
  }

  private estimateContextTokenCount(assembled: string): number {
    return Math.max(1, this.tokenCounter.count(assembled, 'openai'));
  }

  private buildPseudoEmbedding(text: string): number[] {
    const DIM = 32;
    const vec = new Array<number>(DIM).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return vec;

    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const idx = Math.abs(hash) % DIM;
      vec[idx] += 1;
    }

    const norm = Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0));
    if (norm === 0) return vec;
    return vec.map((n) => n / norm);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private tokenizeForMemory(value: string): string[] {
    return Array.from(new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 3)
    ));
  }

  private lexicalOverlapScore(queryTokens: string[], text: string): number {
    if (queryTokens.length === 0) {
      return 0;
    }

    const haystack = new Set(this.tokenizeForMemory(text));
    if (haystack.size === 0) {
      return 0;
    }

    let hits = 0;
    for (const token of queryTokens) {
      if (haystack.has(token)) {
        hits += 1;
      }
    }

    return hits / queryTokens.length;
  }

  private scoreConsciousMemoryEntry(
    queryTokens: string[],
    queryEmbedding: number[],
    text: string,
    timestamp: number,
    boost: number = 0,
  ): number {
    const lexical = this.lexicalOverlapScore(queryTokens, text);
    const semantic = this.cosineSimilarity(this.buildPseudoEmbedding(text), queryEmbedding);
    const ageMinutes = Math.max(0, (Date.now() - timestamp) / 60_000);
    const recency = Math.max(0, 1 - (ageMinutes / 45));
    return (lexical * 0.55) + (semantic * 0.25) + (recency * 0.10) + boost;
  }

  private takeWithinTokenBudget(values: string[], maxTokens: number): string[] {
    if (maxTokens <= 0) {
      return [];
    }

    const selected: string[] = [];
    let used = 0;

    for (const value of values) {
      const tokens = this.tokenCounter.count(value, 'openai');
      if (used + tokens > maxTokens) {
        continue;
      }
      selected.push(value);
      used += tokens;
    }

    return selected;
  }

  private selectConsciousMemoryLines(
    candidates: Array<{ text: string; timestamp: number; boost?: number }>,
    queryTokens: string[],
    queryEmbedding: number[],
    maxItems: number,
    maxTokens: number,
  ): string[] {
    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: this.scoreConsciousMemoryEntry(
          queryTokens,
          queryEmbedding,
          candidate.text,
          candidate.timestamp,
          candidate.boost ?? 0,
        ),
      }))
      .filter((candidate) => candidate.score > 0 || (candidate.boost ?? 0) > 0)
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);

    return this.takeWithinTokenBudget(
      scored.slice(0, Math.max(maxItems * 3, maxItems)).map((candidate) => candidate.text).slice(0, maxItems),
      maxTokens,
    );
  }

  private async getSemanticEmbedding(text: string): Promise<number[]> {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return this.buildPseudoEmbedding(text);
    }

    const cached = this.semanticEmbeddingCache.get(normalized);
    if (cached && (Date.now() - cached.createdAt) < this.semanticEmbeddingTTLms) {
      return cached.embedding;
    }

    this.pruneSemanticEmbeddingCache();

    const provider = getEmbeddingProvider();
    if (provider?.isInitialized()) {
      try {
        const accelerationManager = getActiveAccelerationManager();
        const embedding = accelerationManager
          ? await accelerationManager.runInLane('semantic', () => provider.embed(text))
          : await provider.embed(text);
        this.semanticEmbeddingCache.set(normalized, { embedding, createdAt: Date.now() });
        return embedding;
      } catch (error) {
        console.warn('[SessionTracker] Semantic embedding fallback to pseudo embedding:', error);
      }
    }

    const fallback = this.buildPseudoEmbedding(text);
    this.semanticEmbeddingCache.set(normalized, { embedding: fallback, createdAt: Date.now() });
    return fallback;
  }

  private pruneSemanticEmbeddingCache(): void {
    if (this.semanticEmbeddingCache.size <= this.semanticEmbeddingCacheMaxSize) {
      return;
    }

    const now = Date.now();
    const entries = Array.from(this.semanticEmbeddingCache.entries())
      .filter(([, value]) => now - value.createdAt > this.semanticEmbeddingTTLms)
      .map(([key]) => key);

    for (const key of entries) {
      this.semanticEmbeddingCache.delete(key);
    }

    if (this.semanticEmbeddingCache.size > this.semanticEmbeddingCacheMaxSize) {
      const allEntries = Array.from(this.semanticEmbeddingCache.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = allEntries.slice(0, allEntries.length - this.semanticEmbeddingCacheMaxSize);
      for (const [key] of toRemove) {
        this.semanticEmbeddingCache.delete(key);
      }
    }
  }

  private computeBM25Scores(query: string, documents: string[]): number[] {
    if (documents.length === 0) {
      return [];
    }

    const queryTerms = this.tokenizeForMemory(query);
    if (queryTerms.length === 0) {
      return new Array(documents.length).fill(0);
    }

    const docTerms = documents.map((document) => this.tokenizeForMemory(document));
    const avgDocLength = Math.max(
      1,
      docTerms.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, docTerms.length),
    );
    const k1 = 1.5;
    const b = 0.75;

    return docTerms.map((terms) => {
      if (terms.length === 0) {
        return 0;
      }

      let score = 0;
      for (const term of queryTerms) {
        const tf = terms.filter((candidate) => candidate === term || candidate.includes(term)).length;
        if (tf === 0) {
          continue;
        }

        const df = docTerms.filter((doc) => doc.some((candidate) => candidate === term || candidate.includes(term))).length;
        const idf = Math.log((documents.length - df + 0.5) / (df + 0.5) + 1);
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (terms.length / avgDocLength)));
      }

      return score;
    });
  }

  private computePhaseAlignmentScore(candidatePhase: InterviewPhase | undefined, currentPhase: InterviewPhase): number {
    if (!candidatePhase) {
      return 0.45;
    }

    if (candidatePhase === currentPhase) {
      return 1;
    }

    const phaseOrder: InterviewPhase[] = [
      'requirements_gathering',
      'high_level_design',
      'deep_dive',
      'implementation',
      'complexity_analysis',
      'scaling_discussion',
      'failure_handling',
      'behavioral_story',
      'wrap_up',
    ];

    const left = phaseOrder.indexOf(candidatePhase);
    const right = phaseOrder.indexOf(currentPhase);
    if (left >= 0 && right >= 0 && Math.abs(left - right) <= 1) {
      return 0.72;
    }

    const related = new Set([
      'requirements_gathering:high_level_design',
      'high_level_design:deep_dive',
      'deep_dive:implementation',
      'complexity_analysis:scaling_discussion',
      'scaling_discussion:failure_handling',
    ]);

    if (related.has(`${candidatePhase}:${currentPhase}`) || related.has(`${currentPhase}:${candidatePhase}`)) {
      return 0.5;
    }

    return 0.15;
  }

  private semanticRedundancyScore(
    text: string,
    selectedTexts: string[],
    embedding: number[],
    selectedEmbeddings: number[][],
  ): number {
    if (selectedTexts.length === 0) {
      return 0;
    }

    let maxScore = 0;
    for (let i = 0; i < selectedTexts.length; i++) {
      const semantic = selectedEmbeddings[i]?.length ? this.cosineSimilarity(embedding, selectedEmbeddings[i]) : 0;
      const lexical = this.lexicalOverlapScore(this.tokenizeForMemory(text), selectedTexts[i]);
      maxScore = Math.max(maxScore, Math.max(semantic, lexical));
    }

    return maxScore;
  }

  private computeFacetQueryBoost(text: string, queryTokens: string[]): number {
    const lower = text.toLowerCase();
    let boost = 0;

    if (lower.startsWith('data_model:') && (queryTokens.includes('schema') || queryTokens.includes('model') || queryTokens.includes('data'))) {
      boost += 0.12;
      if (/(table|index|indexes|append-only|schema|secondary index|entity)/i.test(lower)) {
        boost += 0.1;
      }
    }

    if (lower.startsWith('api_contracts:') && (queryTokens.includes('api') || queryTokens.includes('contract') || queryTokens.includes('interface'))) {
      boost += 0.14;
    }

    if (lower.startsWith('failure_modes:') && (queryTokens.includes('failure') || queryTokens.includes('failover') || queryTokens.includes('reliability'))) {
      boost += 0.14;
    }

    if (lower.startsWith('scaling_plan:') && (queryTokens.includes('scale') || queryTokens.includes('throughput') || queryTokens.includes('hotspot'))) {
      boost += 0.12;
    }

    if (lower.startsWith('tradeoffs:') && (queryTokens.includes('tradeoff') || queryTokens.includes('tradeoffs'))) {
      boost += 0.1;
    }

    return boost;
  }

  private ensureFacetCoverage(
    queryTokens: string[],
    rankedCandidates: Array<{ item: ContextItem; finalScore: number }>,
    selected: Array<{ item: ContextItem; embedding: number[] }>,
  ): Array<{ item: ContextItem; embedding: number[] }> {
    const desiredMatchers: Array<(text: string) => boolean> = [];

    if (queryTokens.includes('schema') || queryTokens.includes('model') || queryTokens.includes('data')) {
      desiredMatchers.push((text) => /^data_model:/i.test(text) && /(table|index|append-only|schema|secondary index)/i.test(text));
    }

    if (queryTokens.includes('failure') || queryTokens.includes('failover') || queryTokens.includes('reliability')) {
      desiredMatchers.push((text) => /^failure_modes:/i.test(text));
    }

    if (queryTokens.includes('api') || queryTokens.includes('contract') || queryTokens.includes('interface')) {
      desiredMatchers.push((text) => /^api_contracts:/i.test(text));
    }

    const current = [...selected];
    for (const matcher of desiredMatchers) {
      if (current.some((entry) => matcher(entry.item.text))) {
        continue;
      }

      const candidate = rankedCandidates.find((entry) => matcher(entry.item.text) && !current.some((selectedEntry) => selectedEntry.item.text === entry.item.text));
      if (!candidate) {
        continue;
      }

      current.push({
        item: candidate.item,
        embedding: [],
      });
    }

    return current;
  }

  private async rankConsciousContextItems(
    query: string,
    queryEmbedding: number[],
    candidates: Array<{ item: ContextItem; boost?: number }>,
    tokenBudget: number,
  ): Promise<ContextItem[]> {
    const deduped = new Map<string, { item: ContextItem; boost: number }>();
    for (const candidate of candidates) {
      const key = `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`;
      const existing = deduped.get(key);
      if (!existing || (candidate.boost ?? 0) > existing.boost) {
        deduped.set(key, {
          item: candidate.item,
          boost: candidate.boost ?? 0,
        });
      }
    }

    const merged = Array.from(deduped.values());
    if (merged.length === 0) {
      return [];
    }

    const documents = merged.map((candidate) => candidate.item.text);
    const bm25Scores = this.computeBM25Scores(query, documents);
    const maxBm25 = Math.max(1, ...bm25Scores);
    const queryTokens = this.tokenizeForMemory(query);
    const currentPhase = this.phaseDetector.getCurrentPhase();
    const now = Date.now();

    const preRanked = merged
      .map((candidate, index) => {
        const ageMinutes = Math.max(0, (now - candidate.item.timestamp) / 60_000);
        const recency = Math.exp(-ageMinutes / 20);
        const lexical = this.lexicalOverlapScore(queryTokens, candidate.item.text);
        const phase = this.computePhaseAlignmentScore(candidate.item.phase, currentPhase);
        const bm25 = bm25Scores[index] / maxBm25;
        const facetBoost = this.computeFacetQueryBoost(candidate.item.text, queryTokens);
        return {
          ...candidate,
          bm25,
          lexical,
          phase,
          recency,
          facetBoost,
          preScore: (bm25 * 0.38) + (lexical * 0.22) + (phase * 0.12) + (recency * 0.08) + candidate.boost + facetBoost,
        };
      })
      .sort((left, right) => right.preScore - left.preScore || right.item.timestamp - left.item.timestamp);

    const shortlist = preRanked.slice(0, Math.max(16, Math.min(32, preRanked.length)));
    const semanticEmbeddings = await Promise.all(
      shortlist.map(async (candidate) => ({
        key: `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`,
        embedding: candidate.item.embedding && candidate.item.embedding.length === queryEmbedding.length
          ? candidate.item.embedding
          : await this.getSemanticEmbedding(candidate.item.text),
      }))
    );
    const embeddingByKey = new Map(semanticEmbeddings.map((entry) => [entry.key, entry.embedding]));

    const scored = shortlist.map((candidate) => {
      const key = `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`;
      const semantic = this.cosineSimilarity(embeddingByKey.get(key) || [], queryEmbedding);
      return {
        ...candidate,
        semantic,
        finalScore: (candidate.bm25 * 0.34)
          + (candidate.lexical * 0.18)
          + (semantic * 0.2)
          + (candidate.phase * 0.1)
          + (candidate.recency * 0.08)
          + candidate.boost
          + candidate.facetBoost,
      };
    }).sort((left, right) => right.finalScore - left.finalScore || right.item.timestamp - left.item.timestamp);
    const rankedCandidates = preRanked.map((candidate) => ({
      item: candidate.item,
      finalScore: candidate.preScore,
    }));

    const selected: Array<{ item: ContextItem; embedding: number[] }> = [];
    let usedTokens = 0;
    const lambda = 0.78;

    while (scored.length > 0) {
      let bestIndex = -1;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let index = 0; index < scored.length; index++) {
        const candidate = scored[index];
        const candidateTokens = this.tokenCounter.count(candidate.item.text, 'openai');
        if (usedTokens > 0 && usedTokens + candidateTokens > tokenBudget) {
          continue;
        }

        const key = `${candidate.item.role}:${candidate.item.text.trim().toLowerCase()}`;
        const embedding = embeddingByKey.get(key) || [];
        const redundancy = this.semanticRedundancyScore(
          candidate.item.text,
          selected.map((entry) => entry.item.text),
          embedding,
          selected.map((entry) => entry.embedding),
        );
        const mmrScore = (lambda * candidate.finalScore) - ((1 - lambda) * redundancy);
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = index;
        }
      }

      if (bestIndex === -1) {
        break;
      }

      const [winner] = scored.splice(bestIndex, 1);
      const key = `${winner.item.role}:${winner.item.text.trim().toLowerCase()}`;
      selected.push({
        item: winner.item,
        embedding: embeddingByKey.get(key) || [],
      });
      usedTokens += this.tokenCounter.count(winner.item.text, 'openai');

      if (selected.length >= 12 || usedTokens >= tokenBudget) {
        break;
      }
    }

    return this.ensureFacetCoverage(queryTokens, rankedCandidates, selected)
      .map((entry) => entry.item)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  private inferItemPhase(role: ContextItem['role'], text: string): InterviewPhase {
    if (role !== 'interviewer') {
      return this.phaseDetector.getCurrentPhase();
    }
    return this.detectPhaseFromTranscript(text);
  }

  private shouldRunConstraintExtraction(role: ContextItem['role']): boolean {
    return role === 'interviewer' || role === 'user';
  }

  isLikelyGeneralIntent(lastInterviewerTurn: string | null): boolean {
    return this.observedQuestionStore.isLikelyGeneralIntent(lastInterviewerTurn);
  }

  private getClampedQuery(query: string): string {
    const trimmed = query.trim();
    if (trimmed.length <= this.ADAPTIVE_QUERY_MAX_LEN) return trimmed;
    return trimmed.slice(0, this.ADAPTIVE_QUERY_MAX_LEN);
  }

  private getCacheEntryKey(query: string): string {
    return `${this.sessionId}:${query.trim().toLowerCase()}`;
  }

  private getCachedAssembledContext(query: string): string | null {
    const key = this.getCacheEntryKey(query);
    const entry = this.contextAssembleCache.get(key);
    if (!entry) return null;

    if (entry.revision !== this.transcriptRevision) {
      this.contextAssembleCache.delete(key);
      return null;
    }

    if (Date.now() - entry.createdAt > this.contextCacheTTLms) {
      this.contextAssembleCache.delete(key);
      return null;
    }

    return entry.assembled;
  }

  private setCachedAssembledContext(query: string, assembled: string): void {
    if (this.contextAssembleCache.size >= this.contextCacheMaxEntries) {
      const oldestKey = this.contextAssembleCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.contextAssembleCache.delete(oldestKey);
      }
    }

    this.contextAssembleCache.set(this.getCacheEntryKey(query), {
      assembled,
      tokenCount: this.estimateContextTokenCount(assembled),
      revision: this.transcriptRevision,
      createdAt: Date.now(),
    });
  }

  private getAdaptiveFallbackContext(tokenBudget: number): ContextItem[] {
    // Deterministic fallback ladder:
    // Tier A/B approximation: recency + pinned
    // Tier C: pinned + last N turns
    const lastSeconds = Math.max(30, Math.floor(tokenBudget / 4));
    const recency = this.getContext(lastSeconds);
    const pinnedAsContext: ContextItem[] = this.pinnedItems.map((item) => ({
      role: 'interviewer',
      text: item.label ? `[${item.label}] ${item.text}` : item.text,
      timestamp: item.pinnedAt,
    }));

    const merged = [...pinnedAsContext, ...recency];
    if (merged.length === 0) {
      return this.getContext(120).slice(-Math.max(4, Math.floor(tokenBudget / 20)));
    }
    return merged;
  }

  async getAdaptiveContext(
    query: string,
    queryEmbedding: number[],
    tokenBudget: number = 500
  ): Promise<ContextItem[]> {
    if (this.pendingRestorePromise) {
      await this.pendingRestorePromise.catch(() => {
        // restore failures should not block live flow
      });
    }

    if (!isOptimizationActive('useAdaptiveWindow')) {
      return this.getAdaptiveFallbackContext(tokenBudget);
    }

    const startedAt = Date.now();
    this.adaptiveWindowStats.calls += 1;

    const candidates: ContextEntry[] = this.getContextItems().map((item: ContextItem) => ({
      text: item.text,
      timestamp: item.timestamp,
      phase: item.phase ?? this.phaseDetector.getCurrentPhase(),
      embedding: item.embedding,
    }));

    for (const pinned of this.pinnedItems) {
      candidates.push({
        text: pinned.label ? `[${pinned.label}] ${pinned.text}` : pinned.text,
        timestamp: pinned.pinnedAt,
        phase: this.phaseDetector.getCurrentPhase(),
        embedding: this.buildPseudoEmbedding(pinned.text),
      });
    }

    const normalizedQuery = this.getClampedQuery(query);
    const effectiveEmbedding = queryEmbedding.length > 0
      ? queryEmbedding
      : this.buildPseudoEmbedding(normalizedQuery);
    const questionSignal = detectQuestion(normalizedQuery);

    const config: ContextSelectionConfig = {
      tokenBudget,
      recencyWeight: questionSignal.isQuestion ? 0.35 : 0.45,
      semanticWeight: questionSignal.isQuestion ? 0.45 : 0.35,
      phaseAlignmentWeight: 0.2,
    };

    const window = this.getAdaptiveContextWindow();
    window.setCurrentPhase(this.phaseDetector.getCurrentPhase());
    let selected: ContextEntry[];
    try {
      selected = await this.withTimeout(
        window.selectContext(normalizedQuery, effectiveEmbedding, candidates, config),
        this.ADAPTIVE_WINDOW_TIMEOUT_MS,
        'AdaptiveContextWindow.selectContext'
      );
    } catch (error) {
      this.adaptiveWindowStats.timeouts += 1;
      console.warn('[SessionTracker] Adaptive window timeout, falling back:', error);
      return this.getAdaptiveFallbackContext(tokenBudget);
    }

    const duration = Date.now() - startedAt;
    this.adaptiveWindowStats.totalMs += duration;
    if (duration > 50) {
      this.adaptiveWindowStats.over50ms += 1;
    }

    return selected.map(entry => ({
      role: 'interviewer' as const,
      text: entry.text,
      timestamp: entry.timestamp,
    }));
  }

  async getConsciousRelevantContext(query: string, tokenBudget: number = 900): Promise<ContextItem[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return this.getContext(600).slice(-12);
    }

    const queryEmbedding = await this.getSemanticEmbedding(trimmedQuery);
    const adaptive = await this.getAdaptiveContext(trimmedQuery, queryEmbedding, Math.max(320, Math.floor(tokenBudget * 0.7)));
    const recentTurns = this.getContext(600).slice(-14);
    const designStateEntries = this.designStateStore.getRetrievalEntries(trimmedQuery, 2).map((entry) => ({
      item: {
        role: 'interviewer' as const,
        text: entry.text,
        timestamp: entry.timestamp,
        phase: entry.phase,
        embedding: this.buildPseudoEmbedding(entry.text),
      },
      boost: entry.boost,
    }));
    const pinnedEntries = this.pinnedItems.map((item) => ({
      item: {
        role: 'interviewer' as const,
        text: item.label ? `[${item.label}] ${item.text}` : item.text,
        timestamp: item.pinnedAt,
        phase: this.phaseDetector.getCurrentPhase(),
        embedding: this.buildPseudoEmbedding(item.text),
      },
      boost: 0.2,
    }));
    const constraintEntries = this.extractedConstraints.slice(-8).map((constraint) => ({
      item: {
        role: 'interviewer' as const,
        text: `[${constraint.type}] ${constraint.raw}`,
        timestamp: Date.now(),
        phase: this.phaseDetector.getCurrentPhase(),
        embedding: this.buildPseudoEmbedding(constraint.raw),
      },
      boost: 0.16,
    }));
    const summaryEntries = this.transcriptEpochSummaries.slice(-3).map((summary, index) => ({
      item: {
        role: 'interviewer' as const,
        text: `[Earlier summary ${index + 1}] ${summary}`,
        timestamp: Date.now() - ((this.transcriptEpochSummaries.length - index) * 60_000),
        phase: this.phaseDetector.getCurrentPhase(),
        embedding: this.buildPseudoEmbedding(summary),
      },
      boost: 0.12,
    }));

    const ranked = await this.rankConsciousContextItems(
      trimmedQuery,
      queryEmbedding,
      [
        ...adaptive.map((item) => ({ item, boost: 0.08 })),
        ...recentTurns.map((item) => ({ item, boost: item.role === 'interviewer' ? 0.06 : 0.03 })),
        ...designStateEntries,
        ...pinnedEntries,
        ...constraintEntries,
        ...summaryEntries,
      ],
      Math.max(360, tokenBudget),
    );

    const anchoredRecentTurns = recentTurns.slice(-4);
    const merged = [...ranked, ...anchoredRecentTurns];
    const deduped = new Map<string, ContextItem>();
    for (const item of merged) {
      const key = `${item.role}:${item.text.trim().toLowerCase()}`;
      if (!deduped.has(key)) {
        deduped.set(key, item);
      }
    }

    return Array.from(deduped.values()).sort((left, right) => left.timestamp - right.timestamp);
  }

    getLatestConsciousResponse(): ConsciousModeStructuredResponse | null {
        return this.consciousThreadStore.getLatestConsciousResponse();
    }

    getActiveReasoningThread(): ReasoningThread | null {
        return this.consciousThreadStore.getActiveReasoningThread();
    }

    clearConsciousModeThread(): void {
        this.consciousThreadStore.reset();
        this.answerHypothesisStore.reset();
        this.designStateStore.reset();
    }

    recordConsciousResponse(question: string, response: ConsciousModeStructuredResponse, threadAction: 'start' | 'continue' | 'reset'): void {
        this.consciousThreadStore.recordConsciousResponse(question, response, threadAction);
        this.answerHypothesisStore.recordStructuredSuggestion(question, response, threadAction);
        this.designStateStore.noteStructuredResponse({
          question,
          response,
          timestamp: Date.now(),
          phase: this.phaseDetector.getCurrentPhase(),
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

    setConsciousSemanticContext(block: string): void {
        this.consciousSemanticContext = block || '';
    }

    getConsciousSemanticContext(): string {
        return this.consciousSemanticContext;
    }

    getConsciousLongMemoryContext(query: string): string {
        const activeThread = this.consciousThreadStore.getThreadManager().getActiveThread();
        const latestResponse = this.consciousThreadStore.getLatestConsciousResponse();
        const queryTokens = this.tokenizeForMemory(query);
        const queryEmbedding = this.buildPseudoEmbedding(query);
        const designStateBlock = this.designStateStore.buildContextBlock(query);

        this.tokenBudgetManager.reset();
        const allocations = this.tokenBudgetManager.getAllocations();

        const constraintLines = this.selectConsciousMemoryLines(
          this.extractedConstraints.map((constraint) => ({
            text: `[${constraint.type}] ${constraint.raw}`,
            timestamp: Date.now(),
            boost: 0.18,
          })),
          queryTokens,
          queryEmbedding,
          5,
          Math.min(allocations.entities.max, 220),
        );

        const pinnedLines = this.selectConsciousMemoryLines(
          this.pinnedItems.map((item) => ({
            text: item.label ? `[${item.label}] ${item.text}` : item.text,
            timestamp: item.pinnedAt,
            boost: 0.22,
          })),
          queryTokens,
          queryEmbedding,
          5,
          Math.min(allocations.entities.max, 240),
        );

        const summaryLines = this.selectConsciousMemoryLines(
          this.transcriptEpochSummaries.map((summary, index) => ({
            text: `[Earlier summary ${index + 1}] ${summary}`,
            timestamp: Date.now() - ((this.transcriptEpochSummaries.length - index) * 60_000),
            boost: 0.12,
          })),
          queryTokens,
          queryEmbedding,
          3,
          Math.min(allocations.epochSummaries.max, 420),
        );

        const recentTurns = this.takeWithinTokenBudget(
          this.getContextItems()
            .slice(-10)
            .map((item) => `[${item.role.toUpperCase()}] ${item.text}`),
          Math.min(allocations.recentTranscript.max, 320),
        );

        const lines = [
          '<conscious_long_memory>',
          `CURRENT_PHASE: ${this.phaseDetector.getCurrentPhase()}`,
        ];

        if (activeThread) {
          lines.push(`ACTIVE_THREAD_TOPIC: ${activeThread.topic}`);
          lines.push(`ACTIVE_THREAD_GOAL: ${activeThread.goal}`);
          lines.push(`ACTIVE_THREAD_PHASE: ${activeThread.phase}`);
          lines.push(`ACTIVE_THREAD_TURNS: ${activeThread.turnCount}`);
          if (activeThread.resumeKeywords.length > 0) {
            lines.push(`ACTIVE_THREAD_KEYWORDS: ${activeThread.resumeKeywords.slice(0, 12).join(', ')}`);
          }
          if (activeThread.keyDecisions.length > 0) {
            lines.push(`ACTIVE_THREAD_DECISIONS: ${activeThread.keyDecisions.slice(0, 6).join(' | ')}`);
          }
          if (activeThread.constraints.length > 0) {
            lines.push(`ACTIVE_THREAD_CONSTRAINTS: ${activeThread.constraints.slice(0, 6).join(' | ')}`);
          }
        }

        if (latestResponse) {
          const latestReasoningSummary = [
            latestResponse.openingReasoning,
            latestResponse.implementationPlan[0],
            latestResponse.tradeoffs[0],
            latestResponse.scaleConsiderations[0],
            latestResponse.pushbackResponses[0],
          ].filter(Boolean).join(' ');
          if (latestReasoningSummary) {
            lines.push(`LATEST_REASONING_SUMMARY: ${latestReasoningSummary}`);
          }
        }

        if (constraintLines.length > 0) {
          lines.push('KEY_CONSTRAINTS:');
          lines.push(...constraintLines.map((line) => `- ${line}`));
        }

        if (pinnedLines.length > 0) {
          lines.push('PINNED_MEMORY:');
          lines.push(...pinnedLines.map((line) => `- ${line}`));
        }

        if (summaryLines.length > 0) {
          lines.push('EARLIER_SESSION_SUMMARIES:');
          lines.push(...summaryLines.map((line) => `- ${line}`));
        }

        if (recentTurns.length > 0) {
          lines.push('LATEST_TURNS:');
          lines.push(...recentTurns.map((line) => `- ${line}`));
        }

        lines.push('</conscious_long_memory>');
        return designStateBlock
          ? `${lines.join('\n')}\n\n${designStateBlock}`
          : lines.join('\n');
    }

    /**
     * Get formatted context string for LLM prompts
     */
    getFormattedContext(lastSeconds: number = 120): string {
        const baseCached = this.getCachedAssembledContext(`formatted:${lastSeconds}`);
        if (baseCached) {
          return baseCached;
        }

        const items = this.getContext(lastSeconds);
        const baseContext = items.map(item => {
            const label = item.role === 'interviewer' ? 'INTERVIEWER' :
                item.role === 'user' ? 'ME' :
                    'ASSISTANT (PREVIOUS SUGGESTION)';
            return `[${label}]: ${item.text}`;
        }).join('\n');

        const pinnedSection = this.buildPinnedContextSection();
        const assembled = pinnedSection ? `${pinnedSection}\n${baseContext}` : baseContext;
        this.setCachedAssembledContext(`formatted:${lastSeconds}`, assembled);
        return assembled;
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

    getHotState(now: number = Date.now()): PersistedSessionMemoryEntry[] {
        const cutoff = now - HOT_MEMORY_WINDOW_MS;
        const transcriptEntries = this.fullTranscript
          .filter((segment) => segment.timestamp >= cutoff)
          .map((segment, index) => this.toTranscriptMemoryEntry(segment, `hot-transcript-${index}`));
        const usageEntries = this.fullUsage
          .filter((entry) => entry.timestamp >= cutoff)
          .map((entry, index) => this.toUsageMemoryEntry(entry, `hot-usage-${index}`));

        return this.applyMemoryCeiling([...transcriptEntries, ...usageEntries], HOT_MEMORY_CEILING_BYTES);
    }

    getWarmState(now: number = Date.now()): PersistedSessionMemoryEntry[] {
        const entries: PersistedSessionMemoryEntry[] = [];
        const activeThread = this.consciousThreadStore.getThreadManager().getActiveThread();

        if (activeThread) {
          entries.push(this.toMemoryEntry(`warm-thread-${activeThread.id}`, {
            kind: 'active-thread',
            timestamp: now,
            topic: activeThread.topic,
            goal: activeThread.goal,
            phase: activeThread.phase,
            turnCount: activeThread.turnCount,
          }));
        }

        this.pinnedItems.forEach((item, index) => {
          entries.push(this.toMemoryEntry(`warm-pin-${index}-${item.id}`, {
            kind: 'pinned-item',
            text: item.text,
            timestamp: item.pinnedAt,
            label: item.label,
          }));
        });

        this.extractedConstraints.forEach((constraint, index) => {
          entries.push(this.toMemoryEntry(`warm-constraint-${index}`, {
            kind: 'constraint',
            text: constraint.raw,
            timestamp: now,
            normalized: constraint.normalized,
            raw: constraint.raw,
            constraintType: constraint.type,
          }));
        });

        this.transcriptEpochSummaries.forEach((summary, index) => {
          entries.push(this.toMemoryEntry(`warm-epoch-${index}`, {
            kind: 'epoch-summary',
            text: summary,
            timestamp: now,
          }));
        });

        return this.applyMemoryCeiling(entries, WARM_MEMORY_CEILING_BYTES);
    }

    getColdState(now: number = Date.now()): PersistedSessionMemoryEntry[] {
        const cutoff = now - HOT_MEMORY_WINDOW_MS;
        const transcriptEntries = this.fullTranscript
          .filter((segment) => segment.timestamp < cutoff)
          .map((segment, index) => this.toTranscriptMemoryEntry(segment, `cold-transcript-${index}`));
        const usageEntries = this.fullUsage
          .filter((entry) => entry.timestamp < cutoff)
          .map((entry, index) => this.toUsageMemoryEntry(entry, `cold-usage-${index}`));

        return [...transcriptEntries, ...usageEntries];
    }

    createSuccessorSession(): SessionTracker {
        const next = new SessionTracker();
        next.setRecapLLM(this.recapLLM);
        next.setConsciousModeEnabled(this.consciousModeEnabled);
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
        this.persistState();
      }
    }

    unpinItem(id: string): void {
      this.pinnedItems = this.pinnedItems.filter((item) => item.id !== id);
      this.contextAssembleCache.clear();
      this.persistState();
    }

    clearPinnedItems(): void {
      this.pinnedItems = [];
      this.contextAssembleCache.clear();
      this.persistState();
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
      this.persistState();
    }

    private buildPersistedSession(now: number = Date.now()): PersistedSession {
      const threadManager = this.consciousThreadStore.getThreadManager();
      const activeThread = threadManager.getActiveThread();
      const memoryState: PersistedSessionMemoryState = {
        hot: this.getHotState(now),
        warm: this.getWarmState(now),
        cold: this.getColdState(now),
      };

      return {
        version: 1,
        sessionId: this.sessionId,
        meetingId: this.activeMeetingId,
        createdAt: this.sessionStartTime,
        lastActiveAt: now,
        activeThread: activeThread ? {
          id: activeThread.id,
          topic: activeThread.topic,
          goal: activeThread.goal,
          phase: activeThread.phase,
          turnCount: activeThread.turnCount,
        } : null,
        suspendedThreads: threadManager.getSuspendedThreads().map((thread) => ({
          id: thread.id,
          topic: thread.topic,
          goal: thread.goal,
          suspendedAt: thread.suspendedAt || thread.lastActiveAt,
        })),
        pinnedItems: this.pinnedItems,
        constraints: this.extractedConstraints,
        epochSummaries: [...this.transcriptEpochSummaries],
        responseHashes: this.fingerprinter.getHashes(),
        consciousState: {
          threadState: this.consciousThreadStore.getPersistenceSnapshot(),
          hypothesisState: this.answerHypothesisStore.getPersistenceSnapshot(),
          designState: this.designStateStore.getPersistenceSnapshot(),
        },
        memoryState,
      };
    }

    private persistState(): void {
      if (!this.activeMeetingId || this.activeMeetingId === 'unspecified') return;
      const snapshot = this.buildPersistedSession();
      this.persistence.scheduleSave(snapshot);
    }

    async restoreFromMeetingId(meetingId: string, requestId: number = this.restoreRequestId): Promise<boolean> {
      const normalizedMeetingId = meetingId.trim();
      if (!normalizedMeetingId) return false;

      this.activeMeetingId = normalizedMeetingId;
      const session = await this.persistence.findByMeeting(normalizedMeetingId);
      if (requestId !== this.restoreRequestId) return false;
      if (!session) return false;

      const tooOld = Date.now() - session.lastActiveAt > 2 * 60 * 60 * 1000;
      if (tooOld) {
        return false;
      }

      if (requestId !== this.restoreRequestId) return false;

      this.sessionId = session.sessionId;
      this.sessionStartTime = session.createdAt;
      this.contextItemsBuffer.clear();
      this.fullTranscript = [];
      this.fullUsage = [];
      this.lastAssistantMessage = null;
      this.assistantResponseHistory = [];
      this.pinnedItems = session.pinnedItems || [];
      this.extractedConstraints = (session.constraints || []) as ExtractedConstraint[];
      this.transcriptEpochSummaries = session.epochSummaries || [];
      this.fingerprinter.restore(session.responseHashes || []);
      this.consciousThreadStore.reset();
      this.observedQuestionStore.reset();
      this.answerHypothesisStore.restorePersistenceSnapshot(session.consciousState?.hypothesisState);
      this.designStateStore.restorePersistenceSnapshot(session.consciousState?.designState);

      if (session.activeThread) {
        this.consciousThreadStore.restoreActiveThread({
          id: session.activeThread.id,
          topic: session.activeThread.topic,
          goal: session.activeThread.goal,
          phase: (session.activeThread.phase as InterviewPhase) || 'requirements_gathering',
          turnCount: session.activeThread.turnCount,
        });
      }
      this.consciousThreadStore.restorePersistenceSnapshot(session.consciousState?.threadState);
      this.restorePersistedMemoryState(session.memoryState);

      this.transcriptRevision = this.fullTranscript.length;
      this.contextAssembleCache.clear();
      this.compactSnapshotCache.clear();
      return true;
    }

    ensureMeetingContext(meetingId?: string): void {
      const normalizedMeetingId = meetingId?.trim();
      if (!normalizedMeetingId) return;

      this.activeMeetingId = normalizedMeetingId;
      const requestId = ++this.restoreRequestId;

      this.pendingRestorePromise = this.restoreFromMeetingId(normalizedMeetingId, requestId)
        .then(() => {
          // normalize to Promise<void> for pending gate
        })
        .catch((error) => {
          console.warn('[SessionTracker] Failed to restore persisted session state:', error);
        })
        .finally(() => {
          if (requestId === this.restoreRequestId) {
            this.pendingRestorePromise = null;
          }
        });
    }

    async flushPersistenceNow(): Promise<void> {
      this.persistState();
      await this.persistence.flushScheduledSave();
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
    this.consciousThreadStore.reset();
    this.observedQuestionStore.reset();
    this.answerHypothesisStore.reset();
    this.designStateStore.reset();
    this.consciousSemanticContext = '';
    this.phaseDetector.reset();
    this.tokenBudgetManager.reset();
    this.adaptiveContextWindow = null;
    this.transcriptRevision = 0;
    this.compactSnapshotCache.clear();
    this.contextAssembleCache.clear();
    this.semanticEmbeddingCache.clear();
    this.sessionId = freshSessionId;
    this.pinnedItems = [];
    this.extractedConstraints = [];
    this.fingerprinter.clear();
    this.activeMeetingId = 'unspecified';
    this.pendingRestorePromise = null;
    this.restoreRequestId = 0;
    this.adaptiveWindowStats = {
      calls: 0,
      totalMs: 0,
      over50ms: 0,
      timeouts: 0,
    };
    
    this.pendingCompactionPromise = null;
    this.isCompacting = false;
  }

    // ============================================
    // Private Helpers
    // ============================================

    private toTranscriptMemoryEntry(segment: TranscriptSegment, id: string): PersistedSessionMemoryEntry {
        return this.toMemoryEntry(id, {
          kind: 'transcript',
          text: segment.text,
          timestamp: segment.timestamp,
          speaker: segment.speaker,
          final: segment.final,
          confidence: segment.confidence,
        });
    }

    private toUsageMemoryEntry(entry: UsageInteraction, id: string): PersistedSessionMemoryEntry {
        return this.toMemoryEntry(id, {
          kind: 'usage',
          timestamp: entry.timestamp,
          usageType: entry.type,
          question: entry.question,
          answer: entry.answer,
          items: entry.items,
        });
    }

    private toMemoryEntry(id: string, value: PersistedSessionMemoryEntryValue): PersistedSessionMemoryEntry {
        return {
          id,
          sizeBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
          createdAt: value.timestamp,
          value,
        };
    }

    private applyMemoryCeiling(
      entries: PersistedSessionMemoryEntry[],
      ceilingBytes: number,
    ): PersistedSessionMemoryEntry[] {
      let totalBytes = 0;
      const retained: PersistedSessionMemoryEntry[] = [];

      for (const entry of [...entries].sort((left, right) => right.createdAt - left.createdAt)) {
        if (retained.length > 0 && totalBytes + entry.sizeBytes > ceilingBytes) {
          continue;
        }

        retained.push(entry);
        totalBytes += entry.sizeBytes;
      }

      return retained.sort((left, right) => left.createdAt - right.createdAt);
    }

    private restorePersistedMemoryState(memoryState?: PersistedSessionMemoryState): void {
      if (!memoryState) {
        return;
      }

      const memoryEntries = [...memoryState.cold, ...memoryState.warm, ...memoryState.hot]
        .sort((left, right) => left.createdAt - right.createdAt);

      this.fullTranscript = memoryEntries
        .filter((entry) => entry.value.kind === 'transcript' && entry.value.text)
        .map((entry) => ({
          speaker: entry.value.speaker ?? 'interviewer',
          text: entry.value.text ?? '',
          timestamp: entry.value.timestamp,
          final: entry.value.final ?? true,
          confidence: entry.value.confidence,
        }))
        .slice(-MAX_TRANSCRIPT_ENTRIES);

      this.fullUsage = memoryEntries
        .filter((entry) => entry.value.kind === 'usage' && entry.value.usageType)
        .map((entry) => ({
          type: entry.value.usageType!,
          timestamp: entry.value.timestamp,
          question: entry.value.question,
          answer: entry.value.answer,
          items: entry.value.items,
        }));

      for (const segment of this.fullTranscript.slice(-this.maxContextItems)) {
        const role = this.mapSpeakerToRole(segment.speaker);
        const text = segment.text.trim();
        if (!text) {
          continue;
        }

        this.contextItemsBuffer.push({
          role,
          text,
          timestamp: segment.timestamp,
          phase: this.inferItemPhase(role, text),
          embedding: this.buildPseudoEmbedding(text),
        });
      }

      const assistantSegments = this.fullTranscript.filter((segment) => segment.speaker === 'assistant');
      this.lastAssistantMessage = assistantSegments.at(-1)?.text ?? null;
      this.assistantResponseHistory = assistantSegments
        .slice(-MAX_ASSISTANT_HISTORY)
        .map((segment) => ({
          text: segment.text,
          timestamp: segment.timestamp,
          questionContext: 'restored-session',
        }));
    }

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
