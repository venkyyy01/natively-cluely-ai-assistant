/**
 * Multi-tier screen-share detection with platform-specific strategies.
 *
 * Detection tiers (highest to lowest confidence):
 *   Tier 1: Native module detection (macOS)
 *   Tier 2: TCC database probe (macOS)
 *   Tier 3: Process name matching (all platforms)
 *   Tier 4: Window title matching (macOS)
 *
 * State machine with hysteresis: 3 consecutive negative detection cycles
 * required before emitting 'share-ended'. Monotonic sequence number
 * prevents stale state overwrites from concurrent tier completions.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3B.1, 3B.2, 3B.3, 3B.4
 */

import { EventEmitter } from 'events';

export type DetectionTier = 1 | 2 | 3 | 4;

export interface ScreenShareState {
  active: boolean;
  confidence: DetectionTier | null;
  detectedBy: DetectionTier[];
  consecutiveNegatives: number;
}

export interface ScreenShareDetectorOptions {
  platform?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Native module for tier-1 detection */
  nativeModule?: {
    detectActiveScreenShare?: () => boolean;
  };
  /** TCC database reader for tier-2 — returns bundle IDs with active screen recording */
  tccReader?: () => Promise<string[]>;
  /** Process list provider for tier-3 */
  getProcessList?: () => Array<{ pid: number; ppid: number; name: string }>;
  /** Window title reader for tier-4 */
  getWindowTitles?: () => string[];
  /** Timeout per tier in ms (default: 2000) */
  tierTimeoutMs?: number;
}

/** Number of consecutive negative cycles required before emitting share-ended */
const HYSTERESIS_THRESHOLD = 3;

/** Process names that indicate active screen sharing (tier 3) */
const SCREEN_SHARE_PROCESS_PATTERNS: RegExp = /screencaptureagent|screen ?sharing|screen ?capture|zoom\.us.*cpthost|teams.*sharing|webex.*sharing|slack.*screen/i;

/** Window title patterns that indicate active screen sharing (tier 4) */
const SCREEN_SHARE_TITLE_PATTERNS: RegExp = /sharing your screen|screen share|presenting|you are sharing|sharing screen|screen recording/i;

export class ScreenShareDetector extends EventEmitter {
  private state: ScreenShareState;
  private detecting: boolean;
  private sequenceNumber: number;

  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly nativeModule: ScreenShareDetectorOptions['nativeModule'];
  private readonly tccReader: ScreenShareDetectorOptions['tccReader'];
  private readonly getProcessList: ScreenShareDetectorOptions['getProcessList'];
  private readonly getWindowTitles: ScreenShareDetectorOptions['getWindowTitles'];
  private readonly tierTimeoutMs: number;

  constructor(options: ScreenShareDetectorOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? console;
    this.nativeModule = options.nativeModule;
    this.tccReader = options.tccReader;
    this.getProcessList = options.getProcessList;
    this.getWindowTitles = options.getWindowTitles;
    this.tierTimeoutMs = options.tierTimeoutMs ?? 2000;

    this.state = {
      active: false,
      confidence: null,
      detectedBy: [],
      consecutiveNegatives: 0,
    };
    this.detecting = false;
    this.sequenceNumber = 0;
  }

  /**
   * Run a single detection cycle. Returns current state.
   *
   * Re-entry guard prevents overlapping detection cycles (Req 3B.2).
   * Monotonic sequence number ensures stale results don't overwrite
   * newer state (Req 3B.3).
   */
  async detect(): Promise<ScreenShareState> {
    // Re-entry guard: reject overlapping cycles
    if (this.detecting) {
      return this.getState();
    }

    this.detecting = true;
    const cycleSequence = ++this.sequenceNumber;

    try {
      const tierResults = await this.runDetectionTiers();

      // Check if this cycle is still the latest (monotonic sequence)
      if (cycleSequence !== this.sequenceNumber) {
        // A newer cycle has started — discard this result
        return this.getState();
      }

      this.applyTierResults(tierResults, cycleSequence);
    } catch (error) {
      this.logger.error('[ScreenShareDetector] Detection cycle failed:', error);
      // On total failure, maintain previous state, emit no event
    } finally {
      this.detecting = false;
    }

    return this.getState();
  }

  /** Get current share state without running detection */
  getState(): ScreenShareState {
    return {
      active: this.state.active,
      confidence: this.state.confidence,
      detectedBy: [...this.state.detectedBy],
      consecutiveNegatives: this.state.consecutiveNegatives,
    };
  }

  /** Reset state (for testing) */
  reset(): void {
    this.state = {
      active: false,
      confidence: null,
      detectedBy: [],
      consecutiveNegatives: 0,
    };
    this.detecting = false;
    this.sequenceNumber = 0;
  }

  /**
   * Run all applicable detection tiers with timeout handling.
   * Non-macOS platforms only run tier 3 (process name matching).
   *
   * Each tier is wrapped with a timeout — if a tier exceeds tierTimeoutMs,
   * we proceed with results from completed tiers (Req 3B.4).
   */
  private async runDetectionTiers(): Promise<Map<DetectionTier, boolean>> {
    const results = new Map<DetectionTier, boolean>();

    if (this.platform === 'darwin') {
      // macOS: all 4 tiers (Req 3.2)
      const tierPromises: Array<Promise<void>> = [
        this.runTierWithTimeout(1, () => this.detectTier1()).then(r => { results.set(1, r); }),
        this.runTierWithTimeout(2, () => this.detectTier2()).then(r => { results.set(2, r); }),
        this.runTierWithTimeout(3, () => this.detectTier3()).then(r => { results.set(3, r); }),
        this.runTierWithTimeout(4, () => this.detectTier4()).then(r => { results.set(4, r); }),
      ];

      await Promise.allSettled(tierPromises);
    } else {
      // Non-macOS: process-name only (Req 3.3)
      const tier3Result = await this.runTierWithTimeout(3, () => this.detectTier3());
      results.set(3, tier3Result);

      // Emit "invisibility unverified" warning for non-macOS
      this.logger.warn(
        '[ScreenShareDetector] Non-macOS platform: only process-name detection available. ' +
        'Invisibility unverified — screen share detection confidence is limited.',
      );
    }

    return results;
  }

  /**
   * Run a single tier with timeout. Returns false if the tier times out
   * or throws an error (Req 3B.4).
   */
  private async runTierWithTimeout(
    tier: DetectionTier,
    fn: () => Promise<boolean> | boolean,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.logger.warn(`[ScreenShareDetector] Tier ${tier} timed out after ${this.tierTimeoutMs}ms`);
        resolve(false);
      }, this.tierTimeoutMs);

      try {
        const result = fn();
        if (result instanceof Promise) {
          result
            .then((r) => {
              clearTimeout(timeout);
              resolve(r);
            })
            .catch((err) => {
              clearTimeout(timeout);
              this.logger.warn(`[ScreenShareDetector] Tier ${tier} failed:`, err);
              resolve(false);
            });
        } else {
          clearTimeout(timeout);
          resolve(result);
        }
      } catch (err) {
        clearTimeout(timeout);
        this.logger.warn(`[ScreenShareDetector] Tier ${tier} threw:`, err);
        resolve(false);
      }
    });
  }

  /**
   * Tier 1: Native module detection.
   * Highest confidence — uses native bindings to detect active screen share.
   */
  private detectTier1(): boolean {
    if (!this.nativeModule?.detectActiveScreenShare) {
      return false;
    }
    try {
      return this.nativeModule.detectActiveScreenShare();
    } catch {
      return false;
    }
  }

  /**
   * Tier 2: TCC database probe (macOS).
   * Checks if any app with screen recording permission is actively capturing.
   */
  private async detectTier2(): Promise<boolean> {
    if (!this.tccReader) {
      return false;
    }
    try {
      const activeApps = await this.tccReader();
      return activeApps.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Tier 3: Process name matching.
   * Checks running processes against known screen-sharing process patterns.
   */
  private detectTier3(): boolean {
    if (!this.getProcessList) {
      return false;
    }
    try {
      const processes = this.getProcessList();
      return processes.some(p => SCREEN_SHARE_PROCESS_PATTERNS.test(p.name));
    } catch {
      return false;
    }
  }

  /**
   * Tier 4: Window title matching.
   * Checks window titles for screen-sharing indicators.
   */
  private detectTier4(): boolean {
    if (!this.getWindowTitles) {
      return false;
    }
    try {
      const titles = this.getWindowTitles();
      return titles.some(t => SCREEN_SHARE_TITLE_PATTERNS.test(t));
    } catch {
      return false;
    }
  }

  /**
   * Apply aggregated tier results to the state machine.
   * Implements hysteresis: 3 consecutive negatives required for share-ended.
   * Uses monotonic sequence to prevent stale overwrites (Req 3B.3).
   */
  private applyTierResults(results: Map<DetectionTier, boolean>, cycleSequence: number): void {
    // Stale check: only apply if this is still the latest sequence
    if (cycleSequence !== this.sequenceNumber) {
      return;
    }

    // Aggregate: find which tiers detected a share
    const detectedBy: DetectionTier[] = [];
    for (const [tier, detected] of results) {
      if (detected) {
        detectedBy.push(tier);
      }
    }

    // Sort by tier number (lowest = highest confidence)
    detectedBy.sort((a, b) => a - b);

    const shareDetected = detectedBy.length > 0;

    if (shareDetected) {
      // Reset consecutive negatives on any positive detection
      this.state.consecutiveNegatives = 0;
      this.state.detectedBy = detectedBy;
      // Confidence = highest-ranked tier (lowest number) (Req 3.6)
      this.state.confidence = detectedBy[0];

      if (!this.state.active) {
        // Transition: not-sharing → sharing (Req 3.4)
        this.state.active = true;
        this.emit('share-started', {
          confidence: this.state.confidence,
          detectedBy: [...this.state.detectedBy],
        });
      }
    } else {
      // All tiers negative
      this.state.consecutiveNegatives++;

      if (this.state.active && this.state.consecutiveNegatives >= HYSTERESIS_THRESHOLD) {
        // Transition: sharing → not-sharing after hysteresis (Req 3.5)
        this.state.active = false;
        this.state.confidence = null;
        this.state.detectedBy = [];
        this.emit('share-ended', {});
      }
    }
  }
}
