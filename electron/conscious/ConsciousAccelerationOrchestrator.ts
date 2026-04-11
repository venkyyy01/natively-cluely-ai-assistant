import { PredictivePrefetcher } from '../prefetch/PredictivePrefetcher';
import { InterviewPhase } from './types';
import { PauseDetector, PauseAction, PauseConfidence } from '../pause/PauseDetector';
import { PauseThresholdTuner } from '../pause/PauseThresholdTuner';
import { detectQuestion } from './QuestionDetector';
import { isOptimizationActive } from '../config/optimizations';
import type { RuntimeBudgetScheduler } from '../runtime/RuntimeBudgetScheduler';

type ClassifierLane = Pick<RuntimeBudgetScheduler, 'submit'>;

interface SpeculativeAnswerEntry {
  key: string;
  query: string;
  transcriptRevision: number;
  generation: number;
  startedAt: number;
  promise: Promise<string | null>;
  result?: string | null;
}

export type SpeculativeExecutor = (query: string, transcriptRevision: number) => Promise<string | null>;

export interface ConsciousAccelerationOptions {
  maxPrefetchPredictions?: number;
  maxMemoryMB?: number;
  budgetScheduler?: Pick<RuntimeBudgetScheduler, 'shouldAdmitSpeculation'>;
  classifierLane?: ClassifierLane;
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

  constructor(options: ConsciousAccelerationOptions = {}) {
    this.classifierLane = options.classifierLane;
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
    if (!this.enabled) {
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

  clearState(): void {
    this.prefetcher.onTopicShiftDetected();
    this.prefetcher.clearTranscriptSegments();
    this.latestTranscriptTexts = [];
    this.prefetchTriggeredForCurrentPause = false;
    this.latestInterviewerTranscript = '';
    this.latestTranscriptRevision = 0;
    this.lastPauseDecision = null;
    this.invalidateSpeculation(false);
  }

  private normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private buildSpeculativeKey(query: string, transcriptRevision: number): string {
    return `${transcriptRevision}:${this.normalizeQuery(query)}`;
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
    if (!this.enabled || !this.speculativeExecutor) {
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
        console.warn('[ConsciousAccelerationOrchestrator] Speculative answer generation failed:', error);
        entry.result = null;
        return null;
      });

    this.speculativeAnswerEntries.set(key, entry);
  }

  private invalidateSpeculation(recordOutcome: boolean): void {
    if (recordOutcome && this.enabled && this.speculativeAnswerEntries.size > 0) {
      this.pauseThresholdTuner.recordSpeculationInvalidated();
      this.pauseDetector.updateConfig(this.pauseThresholdTuner.getConfig());
      this.lastPauseDecision = null;
    }

    this.speculativeGeneration += 1;
    this.speculativeAnswerEntries.clear();
  }
}
