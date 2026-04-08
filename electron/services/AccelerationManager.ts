import { PromptCompiler } from '../llm/PromptCompiler';
import { StreamManager } from '../llm/StreamManager';
import { EnhancedCache } from '../cache/EnhancedCache';
import { ParallelContextAssembler, setEmbeddingProvider } from '../cache/ParallelContextAssembler';
import { AdaptiveContextWindow } from '../conscious/AdaptiveContextWindow';
import { PredictivePrefetcher } from '../prefetch/PredictivePrefetcher';
import { ANEEmbeddingProvider } from '../rag/providers/ANEEmbeddingProvider';
import { StealthManager } from '../stealth/StealthManager';
import { getOptimizationFlags, isOptimizationActive } from '../config/optimizations';
import { InterviewPhase } from '../conscious/types';
import { PauseDetector, PauseAction, PauseConfidence } from '../pause/PauseDetector';
import { PauseThresholdTuner } from '../pause/PauseThresholdTuner';
import { detectQuestion } from '../conscious/QuestionDetector';

let activeAccelerationManager: AccelerationManager | null = null;

export function setActiveAccelerationManager(manager: AccelerationManager | null): void {
  activeAccelerationManager = manager;
}

export function getActiveAccelerationManager(): AccelerationManager | null {
  return activeAccelerationManager;
}

export interface AccelerationModules {
  promptCompiler: PromptCompiler;
  streamManager: StreamManager | null;
  enhancedCache: EnhancedCache<string, unknown>;
  parallelAssembler: ParallelContextAssembler;
  adaptiveWindow: AdaptiveContextWindow;
  prefetcher: PredictivePrefetcher;
  aneProvider: ANEEmbeddingProvider;
  stealthManager: StealthManager | null;
  pauseDetector: PauseDetector;
}

interface SpeculativeAnswerEntry {
  key: string;
  query: string;
  normalizedQuery: string;
  transcriptRevision: number;
  generation: number;
  startedAt: number;
  promise: Promise<string | null>;
  result?: string | null;
}

type SpeculativeExecutor = (query: string, transcriptRevision: number) => Promise<string | null>;

export class AccelerationManager {
  private promptCompiler: PromptCompiler;
  private enhancedCache: EnhancedCache<string, unknown>;
  private parallelAssembler: ParallelContextAssembler;
  private adaptiveWindow: AdaptiveContextWindow;
  private prefetcher: PredictivePrefetcher;
  private aneProvider: ANEEmbeddingProvider;
  private pauseDetector: PauseDetector;
  private pauseThresholdTuner: PauseThresholdTuner;
  private currentPhase: InterviewPhase = 'requirements_gathering';
  private consciousModeEnabled = false;
  private latestTranscriptTexts: string[] = [];
  private prefetchTriggeredForCurrentPause = false;
  private latestTranscriptRevision = 0;
  private latestInterviewerTranscript = '';
  private speculativeExecutor: SpeculativeExecutor | null = null;
  private speculativeAnswerEntries = new Map<string, SpeculativeAnswerEntry>();
  private speculativeGeneration = 0;
  private lastPauseDecision: { action: PauseAction; confidence: PauseConfidence; at: number } | null = null;

  constructor() {
    const flags = getOptimizationFlags();

    this.promptCompiler = new PromptCompiler();
    this.enhancedCache = new EnhancedCache({
      maxMemoryMB: flags.maxCacheMemoryMB,
      ttlMs: 5 * 60 * 1000,
      enableSemanticLookup: flags.semanticCacheThreshold > 0,
      similarityThreshold: flags.semanticCacheThreshold,
    });
    this.parallelAssembler = new ParallelContextAssembler({
      workerThreadCount: flags.workerThreadCount,
    });
    this.adaptiveWindow = new AdaptiveContextWindow();
    this.prefetcher = new PredictivePrefetcher({
      maxPrefetchPredictions: flags.maxPrefetchPredictions,
      maxMemoryMB: flags.maxCacheMemoryMB,
    });
    this.aneProvider = new ANEEmbeddingProvider();
    this.pauseDetector = new PauseDetector();
    this.pauseThresholdTuner = new PauseThresholdTuner(this.pauseDetector.getConfig());
    this.pauseDetector.setActionHandler((action: PauseAction) => {
      if (!this.isConsciousAccelerationEnabled()) {
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
      }

      if ((action === 'hard_speculate' || action === 'commit') && isOptimizationActive('usePrefetching')) {
        void this.maybeStartSpeculativeAnswer();
      }
    });
  }

  private isConsciousAccelerationEnabled(): boolean {
    return this.consciousModeEnabled;
  }

  setConsciousModeEnabled(enabled: boolean): void {
    this.consciousModeEnabled = enabled;
    if (!enabled) {
      this.pauseThresholdTuner.reset();
      this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
      this.clearCaches();
    }
  }

  isConsciousModeEnabled(): boolean {
    return this.consciousModeEnabled;
  }

  getPauseThresholdProfile() {
    return this.pauseThresholdTuner.getProfile();
  }

  /**
   * Register ANE provider as the global embedding source
   */
  private registerANEProvider(): void {
    if (isOptimizationActive('useANEEmbeddings') && this.aneProvider.isInitialized()) {
      setEmbeddingProvider(this.aneProvider);
      console.log('[AccelerationManager] ANE provider registered for real embeddings');
    } else {
      setEmbeddingProvider(null);
    }
  }

  private rememberTranscriptText(transcript?: string): void {
    const trimmed = transcript?.trim();
    if (!trimmed) {
      return;
    }

    this.latestTranscriptTexts.push(trimmed);
    if (this.latestTranscriptTexts.length > 5) {
      this.latestTranscriptTexts.shift();
    }
    this.pauseDetector.updateTranscripts(this.latestTranscriptTexts);
  }

  private normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private buildSpeculativeKey(query: string, transcriptRevision: number): string {
    return `${transcriptRevision}:${this.normalizeQuery(query)}`;
  }

  setSpeculativeExecutor(executor: SpeculativeExecutor | null): void {
    this.speculativeExecutor = executor;
  }

  noteTranscriptText(speaker: 'interviewer' | 'user', transcript?: string): void {
    if (!this.isConsciousAccelerationEnabled()) {
      return;
    }

    this.rememberTranscriptText(transcript);
    if (speaker === 'interviewer' && transcript?.trim()) {
      this.latestInterviewerTranscript = transcript.trim();
    }
  }

  private deriveSpeculativeCandidate(): { query: string; transcriptRevision: number } | null {
    const query = this.latestInterviewerTranscript.trim();
    if (!query) {
      return null;
    }

    const detection = detectQuestion(query);
    const wordCount = query.split(/\s+/).filter(Boolean).length;
    if (!detection.isQuestion && wordCount < 5) {
      return null;
    }

    if (query.length < 12) {
      return null;
    }

    return {
      query,
      transcriptRevision: this.latestTranscriptRevision,
    };
  }

  private async maybeStartSpeculativeAnswer(): Promise<void> {
    if (!this.isConsciousAccelerationEnabled() || !this.speculativeExecutor) {
      return;
    }

    const candidate = this.deriveSpeculativeCandidate();
    if (!candidate) {
      return;
    }

    const key = this.buildSpeculativeKey(candidate.query, candidate.transcriptRevision);
    if (this.speculativeAnswerEntries.has(key)) {
      return;
    }

    const generation = this.speculativeGeneration;
    const entry: SpeculativeAnswerEntry = {
      key,
      query: candidate.query,
      normalizedQuery: this.normalizeQuery(candidate.query),
      transcriptRevision: candidate.transcriptRevision,
      generation,
      startedAt: Date.now(),
      promise: Promise.resolve<string | null>(null),
    };

    entry.promise = this.speculativeExecutor(candidate.query, candidate.transcriptRevision)
      .then((result) => {
        if (generation !== this.speculativeGeneration) {
          entry.result = null;
          return null;
        }

        if (candidate.transcriptRevision !== this.latestTranscriptRevision) {
          entry.result = null;
          return null;
        }

        entry.result = result;
        return result;
      })
      .catch((error: unknown): string | null => {
        console.warn('[AccelerationManager] Speculative answer generation failed:', error);
        entry.result = null;
        return null;
      });

    this.speculativeAnswerEntries.set(key, entry);
  }

  async getSpeculativeAnswer(query: string, transcriptRevision: number, waitMs: number = 0): Promise<string | null> {
    if (!this.isConsciousAccelerationEnabled()) {
      return null;
    }

    const key = this.buildSpeculativeKey(query, transcriptRevision);
    const entry = this.speculativeAnswerEntries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.result !== undefined) {
      this.speculativeAnswerEntries.delete(key);
      if (entry.result && this.lastPauseDecision) {
        this.pauseThresholdTuner.recordSuccessfulReuse(this.lastPauseDecision.confidence);
        this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
        this.lastPauseDecision = null;
      }
      return entry.result ?? null;
    }

    if (waitMs <= 0) {
      return null;
    }

    const timeoutSentinel = Symbol('speculative-timeout');
    const result = await Promise.race([
      entry.promise,
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutSentinel), waitMs)),
    ]);

    if (result === timeoutSentinel) {
      return null;
    }

    this.speculativeAnswerEntries.delete(key);
    const resolved = (result as string | null) ?? null;
    if (resolved && this.lastPauseDecision) {
      this.pauseThresholdTuner.recordSuccessfulReuse(this.lastPauseDecision.confidence);
      this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
      this.lastPauseDecision = null;
    }
    return resolved;
  }

  invalidateSpeculation(recordOutcome: boolean = false): void {
    if (recordOutcome && this.isConsciousAccelerationEnabled() && this.speculativeAnswerEntries.size > 0) {
      this.pauseThresholdTuner.recordSpeculationInvalidated();
      this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
      this.lastPauseDecision = null;
    }
    this.speculativeGeneration += 1;
    this.speculativeAnswerEntries.clear();
  }

  /**
   * Update RMS for energy decay analysis
   */
  onUpdateRMS(rms: number): void {
    if (!this.isConsciousAccelerationEnabled()) {
      return;
    }

    this.pauseDetector.updateRMS(rms);
  }

  /**
   * Update transcript segments for prefetching
   */
  updateTranscriptSegments(segments: Array<{ text: string; timestamp: number; speaker: string }>, transcriptRevision?: number): void {
    if (!this.isConsciousAccelerationEnabled()) {
      return;
    }

    this.prefetcher.updateTranscriptSegments(segments);
    if (typeof transcriptRevision === 'number' && transcriptRevision !== this.latestTranscriptRevision) {
      this.latestTranscriptRevision = transcriptRevision;
      this.invalidateSpeculation(true);
    }
  }

  getPauseConfidence(): PauseConfidence {
    return this.pauseDetector.getCurrentConfidence();
  }

  async initialize(): Promise<void> {
    if (isOptimizationActive('useANEEmbeddings')) {
      await this.aneProvider.initialize();
    }

    this.registerANEProvider();
    console.log('[AccelerationManager] Initialized with acceleration modules');
  }

  getPromptCompiler(): PromptCompiler {
    return this.promptCompiler;
  }

  getEnhancedCache(): EnhancedCache<string, unknown> {
    return this.enhancedCache;
  }

  getParallelAssembler(): ParallelContextAssembler {
    return this.parallelAssembler;
  }

  getAdaptiveWindow(): AdaptiveContextWindow {
    return this.adaptiveWindow;
  }

  getPrefetcher(): PredictivePrefetcher {
    return this.prefetcher;
  }

  getANEProvider(): ANEEmbeddingProvider {
    return this.aneProvider;
  }

  setPhase(phase: InterviewPhase): void {
    this.currentPhase = phase;
    this.adaptiveWindow.setCurrentPhase(phase);
    this.prefetcher.onPhaseChange(phase);
  }

  onSilenceStart(transcript?: string): void {
    if (!this.isConsciousAccelerationEnabled()) {
      return;
    }

    this.noteTranscriptText('interviewer', transcript);
    this.prefetchTriggeredForCurrentPause = false;
    this.pauseDetector.onSpeechEnded();
  }

  onUserSpeaking(transcript?: string): void {
    if (!this.isConsciousAccelerationEnabled()) {
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

  clearCaches(): void {
    this.promptCompiler.clearCache();
    this.enhancedCache.clear();
    this.prefetcher.onTopicShiftDetected();
    this.prefetcher.clearTranscriptSegments();
    this.latestTranscriptTexts = [];
    this.prefetchTriggeredForCurrentPause = false;
    this.latestInterviewerTranscript = '';
    this.latestTranscriptRevision = 0;
    this.lastPauseDecision = null;
    this.invalidateSpeculation(false);
  }

  getModules(): AccelerationModules {
    return {
      promptCompiler: this.promptCompiler,
      streamManager: null,
      enhancedCache: this.enhancedCache,
      parallelAssembler: this.parallelAssembler,
      adaptiveWindow: this.adaptiveWindow,
      prefetcher: this.prefetcher,
      aneProvider: this.aneProvider,
      stealthManager: null,
      pauseDetector: this.pauseDetector,
    };
  }
}
