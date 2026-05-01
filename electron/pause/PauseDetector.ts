// PauseDetector - Multi-signal confidence scoring for speculative execution
//
// Distinguishes between:
// - Mid-sentence breaths (100-200ms) → ignore
// - Thinking pauses (500-800ms, incomplete thought) → wait
// - End of sentence (800-1200ms, complete thought) → speculate
// - End of thought (1200ms+, natural conclusion) → commit
//
// Uses 5 weighted signals to calculate confidence that the user is truly done speaking.

export interface PauseSignal {
  name: string;
  weight: number;
  value: number; // 0-1
}

export interface PauseConfidence {
  score: number; // 0-1
  silenceMs: number;
  signals: PauseSignal[];
}

export type PauseAction = 'none' | 'soft_speculate' | 'hard_speculate' | 'commit';

export interface RMSTrendSample {
  timestamp: number;
  rms: number;
}

export interface PauseDetectorConfig {
  // Minimum silence before evaluation starts (ms)
  minSilenceMs: number;
  // Confidence threshold for each action
  softSpeculateThreshold: number;
  hardSpeculateThreshold: number;
  commitThreshold: number;
  // Max evaluation loop duration (ms)
  maxEvaluationMs: number;
  // Evaluation interval (ms)
  evalIntervalMs: number;
}

export const DEFAULT_PAUSE_DETECTOR_CONFIG: PauseDetectorConfig = {
  minSilenceMs: 300,
  softSpeculateThreshold: 0.4,
  hardSpeculateThreshold: 0.6,
  commitThreshold: 0.8,
  maxEvaluationMs: 3000,
  evalIntervalMs: 200,
};

export class PauseDetector {
  private config: PauseDetectorConfig;
  private silenceStartMs: number = 0;
  private recentTranscripts: string[] = [];
  private rmsSamples: RMSTrendSample[] = [];
  private turnStartTime: number = 0;
  private recentTurnDurations: number[] = [];
  private avgTurnDurationMs: number = 3000;
  private onAction: ((action: PauseAction, confidence: PauseConfidence) => void) | null = null;
  private evaluationTimer: ReturnType<typeof setTimeout> | null = null;
  private evaluationStartTime: number = 0;
  private isActive: boolean = false;

  constructor(config: Partial<PauseDetectorConfig> = {}) {
    this.config = { ...DEFAULT_PAUSE_DETECTOR_CONFIG, ...config };
  }

  updateConfig(config: Partial<PauseDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): PauseDetectorConfig {
    return { ...this.config };
  }

  /**
   * Set callback for pause actions
   */
  setActionHandler(handler: (action: PauseAction, confidence: PauseConfidence) => void): void {
    this.onAction = handler;
  }

  /**
   * Called when speech starts (VAD detects voice)
   */
  onSpeechStarted(): void {
    this.silenceStartMs = 0;
    this.turnStartTime = Date.now();
    this.cancelEvaluation();
    this.isActive = false;
  }

  /**
   * Called when speech ends (VAD hangover elapsed)
   */
  onSpeechEnded(): void {
    // Record turn duration if we have a start time
    if (this.turnStartTime > 0) {
      const duration = Date.now() - this.turnStartTime;
      this.recentTurnDurations.push(duration);
      // Keep last 10 turns for averaging
      if (this.recentTurnDurations.length > 10) {
        this.recentTurnDurations.shift();
      }
      this.avgTurnDurationMs = this.recentTurnDurations.reduce((a, b) => a + b, 0) / this.recentTurnDurations.length;
    }

    this.silenceStartMs = Date.now();
    this.isActive = true;
    this.evaluationStartTime = Date.now();
    this.startEvaluation();
  }

  /**
   * Feed transcript segments for completeness analysis
   */
  updateTranscripts(segments: string[]): void {
    this.recentTranscripts = segments.slice(-5);
  }

  /**
   * Feed RMS samples for energy decay analysis
   */
  updateRMS(rms: number): void {
    this.rmsSamples.push({ timestamp: Date.now(), rms });
    // Keep last 20 samples
    if (this.rmsSamples.length > 20) {
      this.rmsSamples.shift();
    }
  }

  /**
   * Cancel any active evaluation (user resumed speaking)
   */
  cancelEvaluation(): void {
    if (this.evaluationTimer) {
      clearTimeout(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    this.isActive = false;
  }

  /**
   * Get current confidence without starting evaluation
   */
  getCurrentConfidence(): PauseConfidence {
    const silenceMs = this.silenceStartMs > 0 ? Date.now() - this.silenceStartMs : 0;
    return this.calculateConfidence(silenceMs);
  }

  /**
   * Check if currently evaluating a pause
   */
  isEvaluating(): boolean {
    return this.isActive && this.silenceStartMs > 0;
  }

  private startEvaluation(): void {
    this.cancelEvaluation();
    this.evaluate();
  }

  private evaluate(): void {
    if (!this.isActive || this.silenceStartMs === 0) return;

    const silenceMs = Date.now() - this.silenceStartMs;
    const elapsed = Date.now() - this.evaluationStartTime;

    // Wait for initial hangover to pass
    if (silenceMs < this.config.minSilenceMs) {
      this.evaluationTimer = setTimeout(() => this.evaluate(), this.config.evalIntervalMs);
      return;
    }

    const confidence = this.calculateConfidence(silenceMs);
    const action = this.determineAction(confidence.score);

    if (this.onAction) {
      this.onAction(action, confidence);
    }

    // Stop conditions
    if (action === 'commit' || elapsed >= this.config.maxEvaluationMs) {
      this.isActive = false;
      return;
    }

    // Continue evaluating
    this.evaluationTimer = setTimeout(() => this.evaluate(), this.config.evalIntervalMs);
  }

  private calculateConfidence(silenceMs: number): PauseConfidence {
    const signals: PauseSignal[] = [
      {
        name: 'silence_duration',
        weight: 0.25,
        value: this.scoreSilenceDuration(silenceMs),
      },
      {
        name: 'transcript_completeness',
        weight: 0.30,
        value: this.scoreTranscriptCompleteness(),
      },
      {
        name: 'semantic_completeness',
        weight: 0.20,
        value: this.scoreSemanticCompleteness(),
      },
      {
        name: 'conversation_rhythm',
        weight: 0.15,
        value: this.scoreConversationRhythm(),
      },
      {
        name: 'audio_energy_decay',
        weight: 0.10,
        value: this.scoreEnergyDecay(),
      },
    ];

    const score = signals.reduce((sum, s) => sum + s.weight * s.value, 0);

    return { score, silenceMs, signals };
  }

  private scoreSilenceDuration(silenceMs: number): number {
    // Ramps from 0 to 1 over 1000ms
    return Math.min(1.0, silenceMs / 1000);
  }

  private scoreTranscriptCompleteness(): number {
    const lastTranscript = this.recentTranscripts.at(-1) || '';
    const trimmed = lastTranscript.trim();

    if (!trimmed) return 0.5;

    // Ends with sentence terminator = likely complete
    if (/[.!?]$/.test(trimmed)) return 0.9;

    // Ends with conjunction = likely incomplete
    if (/\b(and|but|so|because|however|also|then|or|yet|nor|while|although|though|whereas|since|unless|until|whether|if|when|where|why|how)\s*[,.]?\s*$/i.test(trimmed)) return 0.2;

    // Ends with comma = probably continuing
    if (/, $/.test(trimmed)) return 0.3;

    // Ends with ellipsis or trailing dash = thinking
    if (/(\.\.\.|—|--)$/.test(trimmed)) return 0.25;

    // Ends with mid-word fragment = definitely incomplete
    const words = trimmed.split(/\s+/);
    const lastWord = words[words.length - 1] || '';
    if (lastWord.length <= 2 && !/^(a|i|o|to|do|go|be|is|am|are|was|were|in|on|at|by|for|of|the|and|but|or|so|if|as|no|not|up|my|me|he|it|we|you|they)$/.test(lastWord.toLowerCase())) {
      return 0.1;
    }

    return 0.5;
  }

  private scoreSemanticCompleteness(): number {
    const text = this.recentTranscripts.at(-1) || '';
    const words = text.split(/\s+/).filter(Boolean).length;

    // Very short fragments = incomplete
    if (words < 3) return 0.2;

    // Reasonable length with terminator = complete
    if (words >= 5 && /[.!?]$/.test(text.trim())) return 0.9;

    // Long but no terminator = probably rambling/incomplete
    if (words > 20) return 0.4;

    // Medium length, no terminator = ambiguous
    if (words >= 5) return 0.6;

    return 0.4;
  }

  private scoreConversationRhythm(): number {
    if (this.turnStartTime === 0) return 0.5;

    const currentTurnMs = Date.now() - this.silenceStartMs - this.turnStartTime;

    // If current turn is much shorter than average, likely incomplete
    const ratio = this.avgTurnDurationMs > 0 ? currentTurnMs / this.avgTurnDurationMs : 0.5;

    if (ratio < 0.2) return 0.1; // Extremely short turn
    if (ratio < 0.4) return 0.3; // Short turn
    if (ratio > 0.8) return 0.8; // Normal or long turn
    return 0.5;
  }

  private scoreEnergyDecay(): number {
    if (this.rmsSamples.length < 5) return 0.5;

    const recent = this.rmsSamples.slice(-5);
    const earlier = this.rmsSamples.slice(-10, -5);

    if (earlier.length < 3) return 0.5;

    const recentAvg = recent.reduce((sum, s) => sum + s.rms, 0) / recent.length;
    const earlierAvg = earlier.reduce((sum, s) => sum + s.rms, 0) / earlier.length;

    if (earlierAvg === 0) return 0.5;

    const ratio = recentAvg / earlierAvg;

    // Ratio < 0.5 = significant energy drop (trailing off naturally)
    // Ratio ~ 1.0 = steady energy (abrupt stop, might continue)
    // Ratio > 1.0 = energy increasing (definitely not done)
    if (ratio < 0.3) return 0.9; // Natural fade out
    if (ratio < 0.6) return 0.7; // Decreasing
    if (ratio < 0.9) return 0.5; // Slight decrease
    if (ratio < 1.2) return 0.4; // Steady, might continue
    return 0.2; // Increasing, definitely continuing
  }

  private determineAction(score: number): PauseAction {
    if (score >= this.config.commitThreshold) return 'commit';
    if (score >= this.config.hardSpeculateThreshold) return 'hard_speculate';
    if (score >= this.config.softSpeculateThreshold) return 'soft_speculate';
    return 'none';
  }
}
