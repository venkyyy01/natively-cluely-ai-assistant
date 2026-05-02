import { PredictivePrefetcher } from '../prefetch/PredictivePrefetcher';
import { InterviewPhase } from './types';
import { PauseDetector, PauseAction, PauseConfidence } from '../pause/PauseDetector';
import { PauseThresholdTuner } from '../pause/PauseThresholdTuner';
import { detectQuestion } from './QuestionDetector';
import { isOptimizationActive, isVerifierOptimizationActive } from '../config/optimizations';
import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';
import type { IntentResult } from '../llm/IntentClassifier';
import { getIntentConfidenceService } from '../llm/IntentConfidenceService';
import { isStrongConsciousIntent, isUncertainConsciousIntent } from './ConsciousIntentService';

type ClassifierLane = Pick<RuntimeBudgetScheduler, 'submit'>;

interface SpeculativeAnswerEntry {
  key: string;
  query: string;
  transcriptRevision: number;
  generation: number;
  // Monotonic id assigned at entry creation. Carried through preview -> finalize so a
  // caller that observed a preview can detect that invalidation/recreate happened in
  // between (NAT-001 / audit A-1).
  commitToken: number;
  startedAt: number;
  abortController: AbortController;
  embedding: number[];
  chunks: string[];
  partialText: string;
  completed: boolean;
  firstChunkPromise: Promise<void>;
  resolveFirstChunk: () => void;
  completionPromise: Promise<string | null>;
  result?: string | null;
}

export type SpeculativeExecutor = (query: string, transcriptRevision: number, abortSignal: AbortSignal) => AsyncIterableIterator<string>;

export interface SpeculativeAnswerPreview {
  key: string;
  query: string;
  chunks: string[];
  text: string;
  complete: boolean;
  commitToken: number;
}

export interface ConsciousAccelerationOptions {
  maxPrefetchPredictions?: number;
  maxMemoryMB?: number;
  budgetScheduler?: Pick<RuntimeBudgetScheduler, 'shouldAdmitSpeculation'>;
  classifierLane?: ClassifierLane;
  intentClassifier?: (query: string, transcriptRevision: number) => Promise<IntentResult>;
}

export class ConsciousAccelerationOrchestrator {
  private static readonly MAX_SPECULATIVE_ENTRIES = 10;
  private static readonly PREFETCHED_INTENT_TTL_MS = 30_000;
  private readonly prefetcher: PredictivePrefetcher;
  private readonly pauseDetector: PauseDetector;
  private readonly pauseThresholdTuner: PauseThresholdTuner;
  private currentPhase: InterviewPhase = 'requirements_gathering';
  private enabled = false;
  private deepMode = false;
  private latestTranscriptTexts: string[] = [];
  private prefetchTriggeredForCurrentPause = false;
  private latestTranscriptRevision = 0;
  private latestInterviewerTranscript = '';
  private speculativeExecutor: SpeculativeExecutor | null = null;
  private speculativeAnswerEntries = new Map<string, SpeculativeAnswerEntry>();
  private speculativeGeneration = 0;
  private nextCommitToken = 1;
  private lastPauseDecision: { action: PauseAction; confidence: PauseConfidence; at: number } | null = null;
  private readonly classifierLane?: ClassifierLane;
  private intentClassifier?: (query: string, transcriptRevision: number) => Promise<IntentResult>;
  private prefetchedIntents = new Map<string, { intent: IntentResult; fetchedAt: number }>();
  private prefetchedIntentInflight = new Map<string, Promise<void>>();
  private intentPrefetchAbortController: AbortController | null = null;

  constructor(options: ConsciousAccelerationOptions = {}) {
    this.classifierLane = options.classifierLane;
    this.intentClassifier = options.intentClassifier;
    this.prefetcher = new PredictivePrefetcher({
      maxPrefetchPredictions: options.maxPrefetchPredictions,
      maxMemoryMB: options.maxMemoryMB,
      budgetScheduler: options.budgetScheduler,
    });
    this.pauseDetector = new PauseDetector();
    this.pauseThresholdTuner = new PauseThresholdTuner(this.pauseDetector.getConfig());
    this.pauseDetector.setActionHandler((action: PauseAction) => {
      const run = async (): Promise<void> => {
        await this.handlePauseAction(action);
      };

      if (this.classifierLane) {
        void this.classifierLane
          .submit('semantic', run)
          .catch((error: unknown) => {
            console.error('[ConsciousAccelerationOrchestrator] Semantic classifier lane rejected pause action:', error);
          });
        return;
      }

      void run();
    });
  }

  private async handlePauseAction(action: PauseAction): Promise<void> {
      if (!this.enabled) {
        return;
      }

      if (action !== 'none') {
        this.lastPauseDecision = {
          action,
          confidence: this.pauseDetector.getCurrentConfidence(),
          at: Date.now(),
        };
      }

      if ((action === 'hard_speculate' || action === 'commit') && isOptimizationActive('usePrefetching')) {
        // NAT-XXX: Ensure prefetch completes before starting speculative answer.
        // Prefetch is initiated early in onSilenceStart, but if the pause detector
        // fires before it completes, we must await the in-flight prefetch here to
        // avoid a race where speculative answer starts with no prefetched intent.
        await this.maybePrefetchIntent();
        // Deep Mode: skip speculative answer generation — deep mode generates
        // full conscious answers on every turn, making speculation redundant.
        if (!this.deepMode) {
          void this.maybeStartSpeculativeAnswer();
        }
      }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.pauseThresholdTuner.reset();
      this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
      this.clearState();
    }
  }

  setDeepMode(enabled: boolean): void {
    this.deepMode = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPauseThresholdProfile() {
    return this.pauseThresholdTuner.getProfile();
  }

  getPrefetcher(): PredictivePrefetcher {
    return this.prefetcher;
  }

  getPauseDetector(): PauseDetector {
    return this.pauseDetector;
  }

  getPauseConfidence(): PauseConfidence {
    return this.pauseDetector.getCurrentConfidence();
  }

  setPhase(phase: InterviewPhase): void {
    this.currentPhase = phase;
    this.prefetcher.onPhaseChange(phase);
  }

  setSpeculativeExecutor(executor: SpeculativeExecutor | null): void {
    this.speculativeExecutor = executor;
  }

  setIntentClassifier(classifier: ((query: string, transcriptRevision: number) => Promise<IntentResult>) | null): void {
    this.intentClassifier = classifier ?? undefined;
    this.abortInflightIntentPrefetch();
    this.prefetchedIntents.clear();
    this.prefetchedIntentInflight.clear();
  }

  noteTranscriptText(speaker: 'interviewer' | 'user', transcript?: string): void {
    if (!this.enabled) {
      return;
    }

    const trimmed = transcript?.trim();
    if (!trimmed) {
      return;
    }

    this.latestTranscriptTexts.push(trimmed);
    if (this.latestTranscriptTexts.length > 5) {
      this.latestTranscriptTexts.shift();
    }
    this.pauseDetector.updateTranscripts(this.latestTranscriptTexts);

    if (speaker === 'interviewer') {
      this.latestInterviewerTranscript = trimmed;
    }
  }

  onUpdateRMS(rms: number): void {
    if (!this.enabled) {
      return;
    }

    this.pauseDetector.updateRMS(rms);
  }

  onInterviewerAudioActivity(rms: number): void {
    this.onUpdateRMS(rms);
    if (rms > 40) {
      this.onUserSpeaking();
    }
  }

  updateTranscriptSegments(segments: Array<{ text: string; timestamp: number; speaker: string }>, transcriptRevision?: number): void {
    if (!this.enabled) {
      return;
    }

    this.prefetcher.updateTranscriptSegments(segments);
    if (typeof transcriptRevision === 'number' && transcriptRevision !== this.latestTranscriptRevision) {
      this.latestTranscriptRevision = transcriptRevision;
      this.invalidateSpeculation(true);
    }
  }

  onSilenceStart(transcript?: string): void {
    if (!this.enabled) {
      return;
    }

    this.noteTranscriptText('interviewer', transcript);
    this.prefetchTriggeredForCurrentPause = false;

    // NAT-XXX: Start intent prefetch immediately when interviewer stops speaking.
    // Previously, prefetch only started when the pause detector fired (handlePauseAction),
    // which could be too late if the user triggers quickly after the interviewer finishes.
    // By starting prefetch on silence start, we maximize the time available for
    // the foundation model classifier (~2-3s) before the user triggers.
    // Note: prefetcher.onSilenceStart() stays in handlePauseAction to avoid
    // interfering with the speculative answer lifecycle.
    void this.maybePrefetchIntent();

    if (this.classifierLane) {
      void this.classifierLane
        .submit('semantic', async () => {
          this.pauseDetector.onSpeechEnded();
        })
        .catch((error: unknown) => {
          console.error('[ConsciousAccelerationOrchestrator] Semantic classifier lane rejected silence evaluation:', error);
        });
      return;
    }

    this.pauseDetector.onSpeechEnded();
  }

  onUserSpeaking(transcript?: string): void {
    if (!this.enabled) {
      return;
    }

    this.noteTranscriptText('interviewer', transcript);
    this.prefetchTriggeredForCurrentPause = false;
    if (this.lastPauseDecision && (this.lastPauseDecision.action === 'hard_speculate' || this.lastPauseDecision.action === 'commit')) {
      const resumedAfterMs = Date.now() - this.lastPauseDecision.at;
      if (resumedAfterMs <= 1500) {
        this.pauseThresholdTuner.recordFalsePositiveResume(this.lastPauseDecision.action, this.lastPauseDecision.confidence);
        this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
        this.lastPauseDecision = null;
      }
    }
    this.invalidateSpeculation(false);
    this.pauseDetector.onSpeechStarted();
    this.prefetcher.onUserSpeaking();
  }

  async getSpeculativeAnswer(query: string, transcriptRevision: number, waitMs: number = 0): Promise<string | null> {
    const preview = await this.getSpeculativeAnswerPreview(query, transcriptRevision, waitMs);
    if (!preview) {
      return null;
    }

    return this.finalizeSpeculativeAnswer(
      preview.key,
      waitMs > 0 ? Math.max(waitMs, 2000) : 0,
      preview.commitToken,
    );
  }

  getPrefetchedIntent(query: string, transcriptRevision: number): IntentResult | null {
    const key = this.buildSpeculativeKey(query, transcriptRevision);
    const entry = this.prefetchedIntents.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.fetchedAt > ConsciousAccelerationOrchestrator.PREFETCHED_INTENT_TTL_MS) {
      this.prefetchedIntents.delete(key);
      return null;
    }
    return entry.intent;
  }

  clearState(): void {
    this.prefetcher.onTopicShiftDetected();
    this.prefetcher.clearTranscriptSegments();
    this.latestTranscriptTexts = [];
    this.prefetchTriggeredForCurrentPause = false;
    this.latestInterviewerTranscript = '';
    this.latestTranscriptRevision = 0;
    this.lastPauseDecision = null;
    this.abortInflightIntentPrefetch();
    this.prefetchedIntents.clear();
    this.prefetchedIntentInflight.clear();
    this.invalidateSpeculation(false);
  }

  private abortInflightIntentPrefetch(): void {
    if (this.intentPrefetchAbortController) {
      this.intentPrefetchAbortController.abort(new Error('intent_prefetch_cancelled'));
      this.intentPrefetchAbortController = null;
    }
  }

  private isSpeculativeEntryStale(entry: SpeculativeAnswerEntry, expectedTranscriptRevision?: number): boolean {
    if (entry.generation !== this.speculativeGeneration) {
      return true;
    }

    if (entry.transcriptRevision !== this.latestTranscriptRevision) {
      return true;
    }

    if (typeof expectedTranscriptRevision === 'number' && entry.transcriptRevision !== expectedTranscriptRevision) {
      return true;
    }

    return false;
  }

  private normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private buildSpeculativeKey(query: string, transcriptRevision: number): string {
    return `${transcriptRevision}:${this.normalizeQuery(query)}`;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      dotProduct += a[index] * b[index];
      normA += a[index] * a[index];
      normB += b[index] * b[index];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async deriveSpeculativeCandidates(): Promise<Array<{ query: string; transcriptRevision: number; embedding: number[] }>> {
    const query = this.latestInterviewerTranscript.trim();
    if (!query) {
      return [];
    }

    const detection = detectQuestion(query);
    const wordCount = query.split(/\s+/).filter(Boolean).length;
    if (!detection.isQuestion && wordCount < 5) {
      return [];
    }

    if (query.length < 12) {
      return [];
    }

    const candidateQueries = this.prefetcher.getCandidateQueries(query, 3);
    return Promise.all(candidateQueries.map(async (candidate) => ({
      query: candidate.query,
      transcriptRevision: this.latestTranscriptRevision,
      embedding: await this.prefetcher.getSemanticEmbedding(candidate.query),
    })));
  }

  private async selectSpeculativeEntry(query: string, transcriptRevision: number): Promise<SpeculativeAnswerEntry | null> {
    const entries = Array.from(this.speculativeAnswerEntries.values()).filter((entry) => entry.transcriptRevision === transcriptRevision);
    if (entries.length === 0) {
      return null;
    }

    // NAT-002 / audit A-2: exact normalized-match commit only. The previous 0.72
    // cosine fallback could bind a *different* question to another speculative
    // stream's chunks, surfacing a plausible-but-wrong answer. Semantic similarity
    // may be useful for *discarding* candidates in a future change, but never for
    // *selecting* the entry that we promote as the answer.
    const exact = entries.find((entry) => this.normalizeQuery(entry.query) === this.normalizeQuery(query));
    if (exact) {
      return exact;
    }

    // Fuzzy speculation: try to find a close match when no exact match exists
    const useFuzzy = isVerifierOptimizationActive('useFuzzySpeculation');
    if (useFuzzy) {
      const queryEmbedding = await this.prefetcher.getSemanticEmbedding(query);
      if (!queryEmbedding) {
        return null;
      }

      const FUZZY_THRESHOLD = 0.92;
      let bestMatch: SpeculativeAnswerEntry | null = null;
      let bestSimilarity = 0;

      for (const entry of entries) {
        if (!entry.embedding || entry.embedding.length === 0) {
          continue;
        }

        const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
        if (similarity > bestSimilarity && similarity >= FUZZY_THRESHOLD) {
          bestSimilarity = similarity;
          bestMatch = entry;
        }
      }

      if (bestMatch) {
        console.log(`[ConsciousAccelerationOrchestrator] Fuzzy match found: "${query}" -> "${bestMatch.query}" (similarity: ${bestSimilarity.toFixed(3)})`);
        return bestMatch;
      }
    }

    return null;
  }

  private async maybeStartSpeculativeAnswer(): Promise<void> {
    if (!this.enabled || !this.speculativeExecutor) {
      return;
    }

    const latestQuery = this.latestInterviewerTranscript.trim();
    if (!latestQuery) {
      return;
    }

    const prefetchedIntent = this.getPrefetchedIntent(latestQuery, this.latestTranscriptRevision);
    if (!isStrongConsciousIntent(prefetchedIntent)) {
      return;
    }

    const candidates = await this.deriveSpeculativeCandidates();
    if (candidates.length === 0) {
      return;
    }

    const generation = this.speculativeGeneration;

    for (const candidate of candidates) {
      const key = this.buildSpeculativeKey(candidate.query, candidate.transcriptRevision);
      if (this.speculativeAnswerEntries.has(key)) {
        continue;
      }

      let resolveFirstChunk = () => {};
      const abortController = new AbortController();
      const entry: SpeculativeAnswerEntry = {
        key,
        query: candidate.query,
        transcriptRevision: candidate.transcriptRevision,
        generation,
        commitToken: this.nextCommitToken++,
        startedAt: Date.now(),
        abortController,
        embedding: candidate.embedding,
        chunks: [],
        partialText: '',
        completed: false,
        firstChunkPromise: new Promise<void>((resolve) => {
          resolveFirstChunk = resolve;
        }),
        resolveFirstChunk,
        completionPromise: Promise.resolve<string | null>(null),
      };

      entry.completionPromise = (async (): Promise<string | null> => {
        try {
          const stream = this.speculativeExecutor!(candidate.query, candidate.transcriptRevision, abortController.signal);
          for await (const chunk of stream) {
            if (abortController.signal.aborted) {
              entry.result = null;
              entry.completed = true;
              entry.resolveFirstChunk();
              return null;
            }

            if (generation !== this.speculativeGeneration || candidate.transcriptRevision !== this.latestTranscriptRevision) {
              abortController.abort(new Error('speculation_stale'));
              entry.result = null;
              entry.completed = true;
              entry.resolveFirstChunk();
              return null;
            }

            if (chunk) {
              entry.chunks.push(chunk);
              entry.partialText += chunk;
              entry.resolveFirstChunk();
            }
          }

          const trimmed = entry.partialText.trim();
          entry.completed = true;
          entry.result = trimmed.length >= 5 ? trimmed : null;
          entry.resolveFirstChunk();
          return entry.result;
        } catch (error: unknown) {
          if (!abortController.signal.aborted) {
            console.warn('[ConsciousAccelerationOrchestrator] Speculative answer generation failed:', error);
          }
          entry.completed = true;
          entry.result = null;
          entry.resolveFirstChunk();
          return null;
        }
      })();

      this.speculativeAnswerEntries.set(key, entry);
      this.evictStaleSpeculativeEntries();
    }
  }

  private evictStaleSpeculativeEntries(): void {
    if (this.speculativeAnswerEntries.size <= ConsciousAccelerationOrchestrator.MAX_SPECULATIVE_ENTRIES) {
      return;
    }

    const entries = Array.from(this.speculativeAnswerEntries.values())
      .sort((a, b) => a.startedAt - b.startedAt);

    while (this.speculativeAnswerEntries.size > ConsciousAccelerationOrchestrator.MAX_SPECULATIVE_ENTRIES) {
      const oldest = entries.shift();
      if (!oldest) {
        break;
      }
      oldest.abortController.abort(new Error('speculative_evicted'));
      this.speculativeAnswerEntries.delete(oldest.key);
    }
  }

  private async maybePrefetchIntent(): Promise<void> {
    if (!this.intentClassifier) {
      return;
    }

    const query = this.latestInterviewerTranscript.trim();
    if (!query) {
      return;
    }

    const revision = this.latestTranscriptRevision;
    const key = this.buildSpeculativeKey(query, revision);
    if (this.prefetchedIntents.has(key)) {
      return;
    }

    const inflight = this.prefetchedIntentInflight.get(key);
    if (inflight) {
      await inflight;
      return;
    }

    const abortController = new AbortController();
    this.intentPrefetchAbortController = abortController;

    const promise = (async (): Promise<void> => {
      try {
        const intent = await this.intentClassifier!(query, revision);
        if (abortController.signal.aborted) {
          return;
        }
        if (revision !== this.latestTranscriptRevision) {
          return;
        }
        // NAT-005 / audit A-5: only persist a prefetched intent that is
        // NAT-L3: Relax prefetch storage gate. Only discard 'general' intents
        // and truly empty results. A medium-confidence prefetch (0.55-0.82)
        // is still better than timing out on live classify (NAT-L1).
        // The consumer (ConsciousIntentService.resolve) applies its own
        // quality gate before using the result.
        if (intent.intent === 'general' || intent.confidence < 0.45) {
          console.log(
            `[ConsciousAccelerationOrchestrator] intent.prefetch_discarded intent=${intent.intent} confidence=${intent.confidence.toFixed(3)}`,
          );
          return;
        }
        this.prefetchedIntents.set(key, { intent, fetchedAt: Date.now() });
      } catch (error: unknown) {
        if (!abortController.signal.aborted) {
          console.warn('[ConsciousAccelerationOrchestrator] Intent preclassification failed:', error);
        }
      } finally {
        this.prefetchedIntentInflight.delete(key);
        if (this.intentPrefetchAbortController === abortController) {
          this.intentPrefetchAbortController = null;
        }
      }
    })();

    this.prefetchedIntentInflight.set(key, promise);
    await promise;
  }

  async getSpeculativeAnswerPreview(query: string, transcriptRevision: number, waitMs: number = 0): Promise<SpeculativeAnswerPreview | null> {
    if (!this.enabled) {
      return null;
    }

    const entry = await this.selectSpeculativeEntry(query, transcriptRevision);
    if (!entry) {
      return null;
    }

    if (!entry.completed && waitMs > 0) {
      const timeoutSentinel = Symbol('speculative-preview-timeout');
      await Promise.race([
        entry.firstChunkPromise,
        new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutSentinel), waitMs)),
      ]);
    }

    if (this.isSpeculativeEntryStale(entry, transcriptRevision)) {
      entry.abortController.abort(new Error('speculation_stale'));
      this.speculativeAnswerEntries.delete(entry.key);
      return null;
    }

    const text = entry.result ?? entry.partialText;
    if (!text) {
      return null;
    }

    return {
      key: entry.key,
      query: entry.query,
      chunks: [...entry.chunks],
      text,
      complete: entry.completed,
      commitToken: entry.commitToken,
    };
  }

  async finalizeSpeculativeAnswer(
    key: string,
    waitMs: number = 2000,
    expectedCommitToken?: number,
  ): Promise<string | null> {
    const entry = this.speculativeAnswerEntries.get(key);
    if (!entry) {
      return null;
    }

    // NAT-001 / audit A-1: the entry under `key` may have been recreated with a fresh
    // commit token if invalidateSpeculation() ran and a follow-up turn re-populated the
    // same key. Treat any mismatch as abandonment so callers don't promote stale text.
    if (typeof expectedCommitToken === 'number' && entry.commitToken !== expectedCommitToken) {
      return null;
    }

    if (this.isSpeculativeEntryStale(entry)) {
      entry.abortController.abort(new Error('speculation_stale'));
      this.speculativeAnswerEntries.delete(key);
      return null;
    }

    if (!entry.completed) {
      const timeoutSentinel = Symbol('speculative-final-timeout');
      const result = await Promise.race([
        entry.completionPromise,
        new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutSentinel), waitMs)),
      ]);
      if (result !== timeoutSentinel) {
        entry.result = result as string | null;
      } else {
        entry.abortController.abort(new Error('speculation_finalize_timeout'));
      }
    }

    // NAT-001: re-verify the commit token in case the entry was invalidated and a new
    // one took its place while we awaited completionPromise.
    if (typeof expectedCommitToken === 'number' && entry.commitToken !== expectedCommitToken) {
      return null;
    }

    if (this.isSpeculativeEntryStale(entry)) {
      entry.abortController.abort(new Error('speculation_stale'));
      this.speculativeAnswerEntries.delete(key);
      return null;
    }

    this.speculativeAnswerEntries.delete(key);
    const resolved = entry.result ?? (entry.partialText.trim() || null);
    if (resolved && this.lastPauseDecision) {
      this.pauseThresholdTuner.recordSuccessfulReuse(this.lastPauseDecision.confidence);
      this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
      this.lastPauseDecision = null;
    }
    return resolved;
  }

  private invalidateSpeculation(recordOutcome: boolean): void {
    if (recordOutcome && this.enabled && this.speculativeAnswerEntries.size > 0) {
      this.pauseThresholdTuner.recordSpeculationInvalidated();
      this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
      this.lastPauseDecision = null;
    }

    this.abortInflightIntentPrefetch();
    this.speculativeGeneration += 1;
    for (const entry of this.speculativeAnswerEntries.values()) {
      entry.abortController.abort(new Error('speculation_invalidated'));
    }
    this.speculativeAnswerEntries.clear();
    this.prefetchedIntents.clear();
    this.prefetchedIntentInflight.clear();
  }
}
