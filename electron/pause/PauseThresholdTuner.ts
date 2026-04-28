import { DEFAULT_PAUSE_DETECTOR_CONFIG, PauseAction, PauseConfidence, PauseDetectorConfig } from './PauseDetector';

export interface PauseThresholdProfile {
  minSilenceMs: number;
  softSpeculateThreshold: number;
  hardSpeculateThreshold: number;
  commitThreshold: number;
  speculativeReuseRate: number;
  falsePositiveRate: number;
  invalidationRate: number;
  avgSuccessfulPauseMs: number;
  sampleCount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export class PauseThresholdTuner {
  private readonly baseConfig: PauseDetectorConfig;
  private profile: PauseThresholdProfile;
  private aggressiveBias = 0;

  constructor(baseConfig: Partial<PauseDetectorConfig> = {}) {
    this.baseConfig = { ...DEFAULT_PAUSE_DETECTOR_CONFIG, ...baseConfig };
    this.profile = {
      minSilenceMs: this.baseConfig.minSilenceMs,
      softSpeculateThreshold: this.baseConfig.softSpeculateThreshold,
      hardSpeculateThreshold: this.baseConfig.hardSpeculateThreshold,
      commitThreshold: this.baseConfig.commitThreshold,
      speculativeReuseRate: 0,
      falsePositiveRate: 0,
      invalidationRate: 0,
      avgSuccessfulPauseMs: this.baseConfig.minSilenceMs * 2,
      sampleCount: 0,
    };
  }

  getConfig(): PauseDetectorConfig {
    return {
      ...this.baseConfig,
      minSilenceMs: this.profile.minSilenceMs,
      softSpeculateThreshold: this.profile.softSpeculateThreshold,
      hardSpeculateThreshold: this.profile.hardSpeculateThreshold,
      commitThreshold: this.profile.commitThreshold,
    };
  }

  getProfile(): PauseThresholdProfile {
    return { ...this.profile };
  }

  reset(): void {
    this.aggressiveBias = 0;
    this.profile = {
      minSilenceMs: this.baseConfig.minSilenceMs,
      softSpeculateThreshold: this.baseConfig.softSpeculateThreshold,
      hardSpeculateThreshold: this.baseConfig.hardSpeculateThreshold,
      commitThreshold: this.baseConfig.commitThreshold,
      speculativeReuseRate: 0,
      falsePositiveRate: 0,
      invalidationRate: 0,
      avgSuccessfulPauseMs: this.baseConfig.minSilenceMs * 2,
      sampleCount: 0,
    };
  }

  recordSuccessfulReuse(confidence: PauseConfidence): void {
    this.profile.sampleCount += 1;
    this.profile.speculativeReuseRate = this.ema(this.profile.speculativeReuseRate, 1, 0.22);
    this.profile.falsePositiveRate = this.ema(this.profile.falsePositiveRate, 0, 0.12);
    this.profile.invalidationRate = this.ema(this.profile.invalidationRate, 0, 0.12);
    this.profile.avgSuccessfulPauseMs = this.ema(this.profile.avgSuccessfulPauseMs, confidence.silenceMs, 0.28);
    this.aggressiveBias = clamp(this.aggressiveBias - 0.08, -0.35, 0.35);
    this.recomputeThresholds();
  }

  recordFalsePositiveResume(action: PauseAction, confidence: PauseConfidence): void {
    if (action !== 'hard_speculate' && action !== 'commit') {
      return;
    }

    this.profile.sampleCount += 1;
    this.profile.falsePositiveRate = this.ema(this.profile.falsePositiveRate, 1, 0.26);
    this.profile.speculativeReuseRate = this.ema(this.profile.speculativeReuseRate, 0, 0.14);
    this.aggressiveBias = clamp(this.aggressiveBias + 0.12, -0.35, 0.35);

    const effectivePause = Math.max(confidence.silenceMs + 120, this.profile.avgSuccessfulPauseMs);
    this.profile.avgSuccessfulPauseMs = this.ema(this.profile.avgSuccessfulPauseMs, effectivePause, 0.12);
    this.recomputeThresholds();
  }

  recordSpeculationInvalidated(): void {
    this.profile.sampleCount += 1;
    this.profile.invalidationRate = this.ema(this.profile.invalidationRate, 1, 0.2);
    this.profile.speculativeReuseRate = this.ema(this.profile.speculativeReuseRate, 0, 0.1);
    this.aggressiveBias = clamp(this.aggressiveBias + 0.05, -0.35, 0.35);
    this.recomputeThresholds();
  }

  private ema(current: number, next: number, alpha: number): number {
    return current === 0 ? next : current * (1 - alpha) + next * alpha;
  }

  private recomputeThresholds(): void {
    const caution = clamp(
      (this.profile.falsePositiveRate * 0.65) + (this.profile.invalidationRate * 0.35) - (this.profile.speculativeReuseRate * 0.55) + this.aggressiveBias,
      -0.35,
      0.45,
    );

    const learnedPauseMs = clamp(this.profile.avgSuccessfulPauseMs * 0.42, 250, 900);
    const minSilenceMs = clamp(
      Math.round((learnedPauseMs * 0.55) + ((this.baseConfig.minSilenceMs + caution * 260) * 0.45)),
      250,
      900,
    );

    this.profile.minSilenceMs = minSilenceMs;
    this.profile.softSpeculateThreshold = round3(clamp(this.baseConfig.softSpeculateThreshold + caution * 0.08, 0.3, 0.65));
    this.profile.hardSpeculateThreshold = round3(clamp(this.baseConfig.hardSpeculateThreshold + caution * 0.12, 0.45, 0.8));
    this.profile.commitThreshold = round3(clamp(this.baseConfig.commitThreshold + caution * 0.1, 0.6, 0.92));
  }
}
