import { PredictivePrefetcher } from '../prefetch/PredictivePrefetcher';
import { InterviewPhase } from './types';
import { PauseDetector, PauseAction, PauseConfidence } from '../pause/PauseDetector';
import { PauseThresholdTuner } from '../pause/PauseThresholdTuner';
import { detectQuestion } from './QuestionDetector';
import { isOptimizationActive } from '../config/optimizations';
import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';
import type { IntentResult } from '../llm/IntentClassifier';
import { isStrongConsciousIntent } from './ConsciousIntentService';

type ClassifierLane = Pick<RuntimeBudgetScheduler, 'submit'>;

interface SpeculativeAnswerEntry {
  key: string;
  query: string;
  transcriptRevision: number;
  generation: number;
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
}

export interface ConsciousAccelerationOptions {
  maxPrefetchPredictions?: number;
  maxMemoryMB?: number;
  budgetScheduler?: Pick<RuntimeBudgetScheduler, 'shouldAdmitSpeculation'>;
  classifierLane?: ClassifierLane;
  intentClassifier?: (query: string, transcriptRevision: number) => Promise<IntentResult>;
}

export class ConsciousAccelerationOrchestrator {
  private readonly prefetcher: PredictivePrefetcher;
  private readonly pauseDetector: PauseDetector;
  private readonly pauseThresholdTuner: PauseThresholdTuner;
  private currentPhase: InterviewPhase = 'requirements_gathering';
  private enabled = false;
  private latestTranscriptTexts: string[] = [];
  private prefetchTriggeredForCurrentPause = false;
  private latestTranscriptRevision = 0;
  private latestInterviewerTranscript = '';
  private speculativeExecutor: SpeculativeExecutor | null = null;
  private speculativeAnswerEntries = new Map<string, SpeculativeAnswerEntry>();
  private speculativeGeneration = 0;
  private lastPauseDecision: { action: PauseAction; confidence: PauseConfidence; at: number } | null = null;
  private readonly classifierLane?: ClassifierLane;
  private intentClassifier?: (query: string, transcriptRevision: number) => Promise<IntentResult>;
  private prefetchedIntents = new Map<string, IntentResult>();
  private prefetchedIntentInflight = new Map<string, Promise<void>>();

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
            console.warn('[ConsciousAccelerationOrchestrator] Semantic classifier lane rejected pause action:', error);
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

      if ((action === 'soft_speculate' || action === 'hard_speculate' || action === 'commit') && !this.prefetchTriggeredForCurrentPause) {
        this.prefetchTriggeredForCurrentPause = true;
        this.prefetcher.onSilenceStart();
        await this.maybePrefetchIntent();
      }

      if ((action === 'hard_speculate' || action === 'commit') && isOptimizationActive('usePrefetching')) {
        void this.maybeStartSpeculativeAnswer();
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
    if (this.classifierLane) {
      void this.classifierLane
        .submit('semantic', async () => {
          this.pauseDetector.onSpeechEnded();
        })
        .catch((error: unknown) => {
          console.warn('[ConsciousAccelerationOrchestrator] Semantic classifier lane rejected silence evaluation:', error);
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

    return this.finalizeSpeculativeAnswer(preview.key, waitMs > 0 ? Math.max(waitMs, 2000) : 0);
  }

  getPrefetchedIntent(query: string, transcriptRevision: number): IntentResult | null {
    const key = this.buildSpeculativeKey(query, transcriptRevision);
    return this.prefetchedIntents.get(key) ?? null;
  }

  clearState(): void {
    this.prefetcher.onTopicShiftDetected();
    this.prefetcher.clearTranscriptSegments();
    this.latestTranscriptTexts = [];
    this.prefetchTriggeredForCurrentPause = false;
    this.latestInterviewerTranscript = '';
    this.latestTranscriptRevision = 0;
    this.lastPauseDecision = null;
    this.prefetchedIntents.clear();
    this.prefetchedIntentInflight.clear();
    this.invalidateSpeculation(false);
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

    const exact = entries.find((entry) => this.normalizeQuery(entry.query) === this.normalizeQuery(query));
    if (exact) {
      return exact;
    }

    const queryEmbedding = await this.prefetcher.getSemanticEmbedding(query);
    if (queryEmbedding.length === 0) {
      return null;
    }
    let bestMatch: { entry: SpeculativeAnswerEntry; similarity: number } | null = null;

    for (const entry of entries) {
      if (entry.embedding.length === 0) {
        continue;
      }
      const similarity = this.cosineSimilarity(queryEmbedding, entry.embedding);
      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = { entry, similarity };
      }
    }

    return bestMatch && bestMatch.similarity >= 0.72 ? bestMatch.entry : null;
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

    const promise = (async (): Promise<void> => {
      try {
        const intent = await this.intentClassifier!(query, revision);
        if (revision !== this.latestTranscriptRevision) {
          return;
        }
        this.prefetchedIntents.set(key, intent);
      } catch (error: unknown) {
        console.warn('[ConsciousAccelerationOrchestrator] Intent preclassification failed:', error);
      } finally {
        this.prefetchedIntentInflight.delete(key);
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
    };
  }

  async finalizeSpeculativeAnswer(key: string, waitMs: number = 2000): Promise<string | null> {
    const entry = this.speculativeAnswerEntries.get(key);
    if (!entry) {
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

    this.speculativeGeneration += 1;
    for (const entry of this.speculativeAnswerEntries.values()) {
      entry.abortController.abort(new Error('speculation_invalidated'));
    }
    this.speculativeAnswerEntries.clear();
    this.prefetchedIntents.clear();
    this.prefetchedIntentInflight.clear();
  }
}
