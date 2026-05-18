import type { NativeStealthBindings, StealthManager } from './StealthManager';
import type { MonitoringDetector, DetectedThreat } from './MonitoringDetector';
import type { SupervisorBus } from '../runtime/SupervisorBus';
import type { StealthTickCoordinator } from './StealthTickCoordinator';
import { gracefulShutdown } from '../GracefulShutdownManager';
import { loadNativeStealthModule } from './nativeStealthModule';

export interface EnforcementLoopIntervals {
  windowProtectionMs: number; // 250ms
  processDetectionMs: number; // 3000ms
  disguiseValidationMs: number; // 15000ms
  sckExclusionMs?: number; // 2000ms (default)
}

export interface KillSwitchOptions {
  /** If true, quit the app. If false, hide all windows and warn. */
  strictMode: boolean;
  /** Function to hide all windows */
  hideAllWindows: () => void;
  /** Function to show warning to user */
  showWarning: (reason: string) => void;
  /** Function to quit the app */
  quit: (code: number, reason: string) => void;
}

export interface EnforcementLoopOptions {
  stealthManager: StealthManager;
  monitoringDetector: MonitoringDetector;
  bus: SupervisorBus;
  intervals: EnforcementLoopIntervals;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  exitFn?: (code: number, reason: string) => void;
  /** Kill switch configuration. If not provided, defaults are derived from environment. */
  killSwitch?: Partial<KillSwitchOptions>;
  /** Optional StealthTickCoordinator for centralized tick scheduling. When provided, registers handlers instead of using independent setInterval calls. */
  tickCoordinator?: StealthTickCoordinator;
  /** Optional native module override for deterministic tests. Runtime uses the cached loader. */
  nativeModule?: NativeStealthBindings | null;
}

interface ViolationRecord {
  timestamp: number;
  type: string;
}

/** Default SCK exclusion poll interval (2 seconds) */
const DEFAULT_SCK_EXCLUSION_INTERVAL_MS = 2000;

/** Number of consecutive failures before triggering emergency protection */
const SCK_MAX_CONSECUTIVE_FAILURES = 3;

/** Back off after repeated permanent SCK verification failures to avoid hammering WindowServer. */
const SCK_PERSISTENT_FAILURE_BACKOFF_MS = 15_000;

export class ContinuousEnforcementLoop {
  private readonly stealthManager: StealthManager;
  private readonly monitoringDetector: MonitoringDetector;
  private readonly bus: SupervisorBus;
  private readonly intervals: EnforcementLoopIntervals;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly exitFn: (code: number, reason: string) => void;
  private readonly killSwitch: KillSwitchOptions;
  private readonly tickCoordinator: StealthTickCoordinator | null;
  private readonly nativeModuleOverride: NativeStealthBindings | null | undefined;

  private windowProtectionTimer: NodeJS.Timeout | null = null;
  private processDetectionTimer: NodeJS.Timeout | null = null;
  private disguiseValidationTimer: NodeJS.Timeout | null = null;
  private sckExclusionTimer: NodeJS.Timeout | null = null;
  /** Indicates whether handlers are registered with the tick coordinator */
  private usingTickCoordinator = false;
  private running = false;
  private windowProtectionRunning = false;
  private processDetectionRunning = false;
  private disguiseValidationRunning = false;
  private sckExclusionRunning = false;

  // Violation ring buffer: if 3+ violations within 60s, trigger immediate quit
  private violations: ViolationRecord[] = [];
  private static readonly MAX_VIOLATIONS = 3;
  private static readonly VIOLATION_WINDOW_MS = 60000;

  // SCK exclusion: track consecutive failures per window number
  private readonly sckConsecutiveFailures = new Map<number, number>();
  private readonly sckBackoffUntil = new Map<number, number>();
  private sckExclusionFailureCount = 0;
  private sckExclusionReapplyCount = 0;

  /**
   * Monotonic enforcement-epoch counter.
   * Incremented each time the kill-switch triggers a hide-all-windows action.
   * Used to ensure hide operations take precedence over user-initiated show
   * operations that may race with the kill-switch response.
   */
  private enforcementEpoch = 0;

  constructor(options: EnforcementLoopOptions) {
    this.stealthManager = options.stealthManager;
    this.monitoringDetector = options.monitoringDetector;
    this.bus = options.bus;
    this.intervals = options.intervals;
    this.logger = options.logger ?? console;
    this.tickCoordinator = options.tickCoordinator ?? null;
    this.nativeModuleOverride = options.nativeModule;

    // Resolve kill-switch configuration
    const strictMode = options.killSwitch?.strictMode ??
      (process.env.NATIVELY_STRICT_KILL_SWITCH === '1');

    const defaultQuit = (code: number, reason: string) => {
      gracefulShutdown.shutdown(code, reason).catch(() => {
        setTimeout(() => process.exit(code), 3000);
      });
    };

    this.killSwitch = {
      strictMode,
      hideAllWindows: options.killSwitch?.hideAllWindows ?? (() => {
        // Default: hide all managed windows via stealth manager
        const managedWindows = this.stealthManager.getManagedWindowNumbers();
        for (const { win } of managedWindows) {
          this.stealthManager.requestWindowHide(win, {
            source: 'ContinuousEnforcementLoop.killSwitch',
            windowRole: 'primary',
          });
        }
      }),
      showWarning: options.killSwitch?.showWarning ?? ((reason: string) => {
        this.logger.warn(`[ContinuousEnforcementLoop] Kill-switch warning: ${reason}`);
      }),
      quit: options.killSwitch?.quit ?? defaultQuit,
    };

    // Preserve legacy exitFn for backward compatibility
    this.exitFn = options.exitFn ?? defaultQuit;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    if (this.tickCoordinator) {
      // Register all handlers with the tick coordinator using calculated cadences.
      // Per-handler "is-running" guards are preserved as an additional layer of
      // protection alongside the coordinator's per-id serialization.

      // Window protection: 250ms / 250ms base = cadence 1
      this.tickCoordinator.register({
        id: 'enforcement-window-protection',
        cadence: 1,
        lane: 'background',
        fn: () => this.runWindowProtection(),
      });

      // Process detection: 3000ms / 250ms base = cadence 12
      this.tickCoordinator.register({
        id: 'enforcement-process-detection',
        cadence: 12,
        lane: 'background',
        fn: () => this.runProcessDetection(),
      });

      // Disguise validation: 15000ms / 250ms base = cadence 60
      this.tickCoordinator.register({
        id: 'enforcement-disguise-validation',
        cadence: 60,
        lane: 'background',
        fn: () => this.runDisguiseValidation(),
      });

      // SCK exclusion: 2000ms / 250ms base = cadence 8 (macOS 15+ only).
      // Gated behind isSckTagExperimentEnabled() — Acceleration Mode (the
      // master `useStealthMode` flag) OR `NATIVELY_TRY_SCK_TAG=1`. The
      // loop verifies and rewrites the experimental CGS tag bit, so it
      // must not run when the experiment is opted out.
      if (this.isSckTagExperimentEnabled() && this.stealthManager.isMacOS15PlusCapable()) {
        this.tickCoordinator.register({
          id: 'enforcement-sck-exclusion',
          cadence: 8,
          lane: 'background',
          fn: () => this.pollSckExclusion(),
        });
      }

      this.usingTickCoordinator = true;
    } else {
      // Fallback: use independent setInterval calls

      // Window protection loop (250ms)
      this.windowProtectionTimer = setInterval(() => {
        void this.runWindowProtection();
      }, this.intervals.windowProtectionMs);
      this.windowProtectionTimer.unref?.();

      // Process detection loop (3s)
      this.processDetectionTimer = setInterval(() => {
        void this.runProcessDetection();
      }, this.intervals.processDetectionMs);
      this.processDetectionTimer.unref?.();

      // Disguise validation loop (15s)
      this.disguiseValidationTimer = setInterval(() => {
        void this.runDisguiseValidation();
      }, this.intervals.disguiseValidationMs);
      this.disguiseValidationTimer.unref?.();

      // SCK exclusion verification loop (2s default, macOS 15+ only).
      // Gated behind isSckTagExperimentEnabled() — Acceleration Mode OR
      // NATIVELY_TRY_SCK_TAG=1. See the tick-coordinator branch.
      if (this.isSckTagExperimentEnabled() && this.stealthManager.isMacOS15PlusCapable()) {
        const sckInterval = this.intervals.sckExclusionMs ?? DEFAULT_SCK_EXCLUSION_INTERVAL_MS;
        this.sckExclusionTimer = setInterval(() => {
          void this.pollSckExclusion();
        }, sckInterval);
        this.sckExclusionTimer.unref?.();
      }
    }

    this.logger.log('[ContinuousEnforcementLoop] Started');
  }

  stop(): void {
    this.running = false;

    if (this.usingTickCoordinator && this.tickCoordinator) {
      // Deregister all handlers from the tick coordinator
      this.tickCoordinator.deregister('enforcement-window-protection');
      this.tickCoordinator.deregister('enforcement-process-detection');
      this.tickCoordinator.deregister('enforcement-disguise-validation');
      this.tickCoordinator.deregister('enforcement-sck-exclusion');
      this.usingTickCoordinator = false;
    } else {
      // Clear independent setInterval timers
      if (this.windowProtectionTimer) {
        clearInterval(this.windowProtectionTimer);
        this.windowProtectionTimer = null;
      }
      if (this.processDetectionTimer) {
        clearInterval(this.processDetectionTimer);
        this.processDetectionTimer = null;
      }
      if (this.disguiseValidationTimer) {
        clearInterval(this.disguiseValidationTimer);
        this.disguiseValidationTimer = null;
      }
      if (this.sckExclusionTimer) {
        clearInterval(this.sckExclusionTimer);
        this.sckExclusionTimer = null;
      }
    }

    this.logger.log('[ContinuousEnforcementLoop] Stopped');
  }

  private async runWindowProtection(): Promise<void> {
    if (this.windowProtectionRunning) {
      return;
    }
    this.windowProtectionRunning = true;

    try {
      this.stealthManager.reapplyProtectionLayers();
    } catch (error) {
      this.logger.warn('[ContinuousEnforcementLoop] Window protection failed:', error);
      this.recordViolation('window-protection-failed');
    } finally {
      this.windowProtectionRunning = false;
    }
  }

  private async runProcessDetection(): Promise<void> {
    if (this.processDetectionRunning) {
      return;
    }
    this.processDetectionRunning = true;

    try {
      const threats = await this.monitoringDetector.detect();

      for (const threat of threats) {
        if (threat.severity === 'critical') {
          await this.handleCriticalThreat(threat);
        } else if (threat.severity === 'warning') {
          await this.handleWarningThreat(threat);
        }
      }
    } catch (error) {
      this.logger.warn('[ContinuousEnforcementLoop] Process detection failed:', error);
    } finally {
      this.processDetectionRunning = false;
    }
  }

  private async runDisguiseValidation(): Promise<void> {
    if (this.disguiseValidationRunning) {
      return;
    }
    this.disguiseValidationRunning = true;

    try {
      await this.validateDisguise();
    } catch (error) {
      this.logger.warn('[ContinuousEnforcementLoop] Disguise validation failed:', error);
    } finally {
      this.disguiseValidationRunning = false;
    }
  }

  /**
   * Whether the experimental SCK CGS tag path is enabled.
   * See `StealthManager.isSckTagExperimentEnabled` for full rationale.
   *
   * Default OFF. Opt in via `NATIVELY_TRY_SCK_TAG=1`.
   */
  private isSckTagExperimentEnabled(): boolean {
    return process.env.NATIVELY_TRY_SCK_TAG === '1';
  }

  /**
   * Polls SCK exclusion state for all managed windows.
   * For each window, verifies the exclusion tag is still set.
   * If verification fails, re-applies the exclusion and tracks consecutive failures.
   * After SCK_MAX_CONSECUTIVE_FAILURES consecutive failures for a window,
   * triggers emergency protection (hides the window).
   *
   * EXPERIMENTAL — gated behind Acceleration Mode (`useStealthMode`
   * optimization flag) OR `NATIVELY_TRY_SCK_TAG=1`. The CGS tag bit
   * (1 << 3) the loop reads and writes is reverse-engineered and
   * undocumented. Default flow opts out so we never spin on a bit whose
   * semantics we can't trust.
   */
  private async pollSckExclusion(): Promise<void> {
    if (!this.isSckTagExperimentEnabled()) {
      return;
    }
    if (this.sckExclusionRunning) {
      return;
    }
    this.sckExclusionRunning = true;

    try {
      const nativeModule = this.getNativeModule();
      if (!nativeModule?.verifySckExclusion || !nativeModule?.applySckExclusion) {
        return;
      }

      const now = Date.now();
      const managedWindows = this.stealthManager.getManagedWindowNumbers();
      // Clean up failure tracking for windows that are no longer managed
      const activeWindowNumbers = new Set(managedWindows.map(w => w.windowNumber));
      for (const windowNumber of this.sckConsecutiveFailures.keys()) {
        if (!activeWindowNumbers.has(windowNumber)) {
          this.sckConsecutiveFailures.delete(windowNumber);
        }
      }
      for (const windowNumber of this.sckBackoffUntil.keys()) {
        if (!activeWindowNumbers.has(windowNumber)) {
          this.sckBackoffUntil.delete(windowNumber);
        }
      }

      for (const { windowNumber } of managedWindows) {
        try {
          const backoffUntil = this.sckBackoffUntil.get(windowNumber) ?? 0;
          if (backoffUntil > now) {
            continue;
          }

          const isExcluded = nativeModule.verifySckExclusion(windowNumber);

          if (isExcluded) {
            // Verification passed — reset consecutive failure/backoff state.
            this.sckConsecutiveFailures.delete(windowNumber);
            this.sckBackoffUntil.delete(windowNumber);
            continue;
          }

          // Verification failed — re-apply exclusion
          this.logger.warn(
            `[ContinuousEnforcementLoop] SCK exclusion lost for window ${windowNumber}, re-applying`
          );
          this.sckExclusionReapplyCount++;

          try {
            nativeModule.applySckExclusion(windowNumber);
            if (nativeModule.verifySckExclusion(windowNumber)) {
              this.sckConsecutiveFailures.delete(windowNumber);
              this.sckBackoffUntil.delete(windowNumber);
              continue;
            }
          } catch (applyError) {
            this.logger.warn(
              `[ContinuousEnforcementLoop] SCK exclusion re-apply failed for window ${windowNumber}:`,
              applyError
            );
          }

          // Track consecutive failures
          const failures = (this.sckConsecutiveFailures.get(windowNumber) ?? 0) + 1;
          this.sckConsecutiveFailures.set(windowNumber, failures);
          this.sckExclusionFailureCount++;

          if (failures >= SCK_MAX_CONSECUTIVE_FAILURES) {
            this.sckBackoffUntil.set(windowNumber, now + SCK_PERSISTENT_FAILURE_BACKOFF_MS);
            this.logger.warn(
              `[ContinuousEnforcementLoop] SCK exclusion failed ${failures} consecutive times for window ${windowNumber} — backing off ${SCK_PERSISTENT_FAILURE_BACKOFF_MS}ms without hiding windows`
            );
            this.sckConsecutiveFailures.delete(windowNumber);
          }
        } catch (error) {
          this.logger.warn(
            `[ContinuousEnforcementLoop] SCK exclusion check error for window ${windowNumber}:`,
            error
          );
          // Count as a failure for this window
          const failures = (this.sckConsecutiveFailures.get(windowNumber) ?? 0) + 1;
          this.sckConsecutiveFailures.set(windowNumber, failures);
          this.sckExclusionFailureCount++;

          if (failures >= SCK_MAX_CONSECUTIVE_FAILURES) {
            this.sckBackoffUntil.set(windowNumber, now + SCK_PERSISTENT_FAILURE_BACKOFF_MS);
            this.logger.warn(
              `[ContinuousEnforcementLoop] SCK exclusion check failed ${failures} consecutive times for window ${windowNumber} — backing off ${SCK_PERSISTENT_FAILURE_BACKOFF_MS}ms without hiding windows`
            );
            this.sckConsecutiveFailures.delete(windowNumber);
          }
        }
      }
    } catch (error) {
      this.logger.warn('[ContinuousEnforcementLoop] SCK exclusion poll failed:', error);
    } finally {
      this.sckExclusionRunning = false;
    }
  }

  private getNativeModule(): NativeStealthBindings | null {
    if (this.nativeModuleOverride !== undefined) {
      return this.nativeModuleOverride;
    }

    return loadNativeStealthModule({ retryOnFailure: false });
  }

  private async handleCriticalThreat(threat: DetectedThreat): Promise<void> {
    this.logger.error(`[ContinuousEnforcementLoop] CRITICAL threat detected: ${threat.name} (PID: ${threat.pid})`);

    const reason = `monitoring-tool-detected:${threat.name}`;
    await this.triggerKillSwitch(reason);
  }

  private async handleWarningThreat(threat: DetectedThreat): Promise<void> {
    this.logger.warn(`[ContinuousEnforcementLoop] Warning threat detected: ${threat.name} (PID: ${threat.pid})`);

    // Warning-level screen-share tools should not enter fault containment.
    // Older stealth behavior kept the user surface visible and simply
    // re-applied capture protection; emitting stealth:fault here activates the
    // renderer privacy shield and creates the black blink loop under Zoom.
    void this.stealthManager.pollCaptureTools?.();
  }

  private async validateDisguise(): Promise<void> {
    // Verify: dock hidden, tray hidden, window titles match
    // These are platform-specific checks
    const { app } = await import('electron');

    // Check dock visibility on macOS
    if (process.platform === 'darwin' && app.dock?.isVisible?.()) {
      this.logger.warn('[ContinuousEnforcementLoop] Dock is visible in stealth mode');
      app.dock.hide();
    }

    // Additional disguise validation can be added here
  }

  private recordViolation(type: string): void {
    const now = Date.now();
    this.violations.push({ timestamp: now, type });

    // Clean old violations outside the window
    this.violations = this.violations.filter(v => now - v.timestamp < ContinuousEnforcementLoop.VIOLATION_WINDOW_MS);

    // Check if we exceed max violations
    if (this.violations.length >= ContinuousEnforcementLoop.MAX_VIOLATIONS) {
      this.logger.error('[ContinuousEnforcementLoop] Maximum violations exceeded, triggering kill switch');
      void this.triggerKillSwitch('max-violations-exceeded');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Triggers the kill-switch response based on the configured mode.
   *
   * Non-strict (default): hide all windows → emit `stealth:fault` → show user warning.
   * Strict (`NATIVELY_STRICT_KILL_SWITCH=1`): call gracefulShutdown.shutdown(1, reason).
   *
   * In non-strict mode, increments the enforcement-epoch counter so that
   * any racing user-initiated window-show operations are overridden.
   */
  async triggerKillSwitch(reason: string): Promise<void> {
    if (this.killSwitch.strictMode) {
      this.logger.error(`[ContinuousEnforcementLoop] Kill-switch (strict): shutting down — ${reason}`);
      this.killSwitch.quit(1, reason);
      return;
    }

    // Non-strict mode: hide all windows → emit stealth:fault → show warning
    this.logger.warn(`[ContinuousEnforcementLoop] Kill-switch (non-strict): hiding windows — ${reason}`);

    // Increment enforcement epoch to establish hide precedence
    this.enforcementEpoch++;

    this.killSwitch.hideAllWindows();

    await this.bus.emit({
      type: 'stealth:fault',
      reason,
    });

    this.killSwitch.showWarning(reason);
  }

  /**
   * Returns the current enforcement epoch.
   * Used by window-show logic to determine if a hide operation
   * should take precedence over a user-initiated show.
   */
  getEnforcementEpoch(): number {
    return this.enforcementEpoch;
  }

  /**
   * Checks whether a window-show operation should be suppressed
   * because a kill-switch hide is active at a newer epoch.
   *
   * @param showEpoch - The epoch at which the show was initiated.
   *   If the current enforcement epoch is greater than showEpoch,
   *   the hide takes precedence and the show should be suppressed.
   */
  shouldSuppressShow(showEpoch: number): boolean {
    return this.enforcementEpoch > showEpoch;
  }

  /** Returns the total number of SCK exclusion failures detected since start. */
  getSckExclusionFailureCount(): number {
    return this.sckExclusionFailureCount;
  }

  /** Returns the total number of SCK exclusion re-applications triggered since start. */
  getSckExclusionReapplyCount(): number {
    return this.sckExclusionReapplyCount;
  }
}
