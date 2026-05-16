/**
 * WindowsCaptureEnforcementLoop
 *
 * Mirrors the macOS SCK-exclusion enforcement loop for Windows.
 * Periodically verifies that every managed window still has
 * WDA_EXCLUDEFROMCAPTURE display affinity. If the affinity has been
 * stripped (display sleep/wake, monitor disconnect, session lock/unlock,
 * external app interfering), re-applies it immediately.
 *
 * After SCK_MAX_CONSECUTIVE_FAILURES, fails closed by emitting a warning
 * to the StealthManager so the privacy shield can engage and the user is
 * notified.
 */

import type { StealthManager } from './StealthManager';
import type { NativeStealthBindings } from './StealthManager';
import { loadNativeStealthModule } from './nativeStealthModule';
import { Metrics } from '../runtime/Metrics';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;
const PERSISTENT_FAILURE_BACKOFF_MS = 30_000;

export interface WindowsCaptureEnforcementLoopOptions {
  pollIntervalMs?: number;
  nativeModule?: NativeStealthBindings | null;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface WindowEnforcementState {
  consecutiveFailures: number;
  backoffUntil: number;
}

export class WindowsCaptureEnforcementLoop {
  private readonly stealthManager: StealthManager;
  private readonly pollIntervalMs: number;
  private readonly nativeModuleOverride: NativeStealthBindings | null | undefined;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly windowState = new Map<number, WindowEnforcementState>();
  private reapplyCount = 0;
  private failureCount = 0;

  constructor(stealthManager: StealthManager, options: WindowsCaptureEnforcementLoopOptions = {}) {
    this.stealthManager = stealthManager;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.nativeModuleOverride = options.nativeModule;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (process.platform !== 'win32') {
      return;
    }
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    this.logger.log(
      `[WindowsCaptureEnforcementLoop] Started (interval=${this.pollIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.windowState.clear();
  }

  /**
   * Re-apply protection on display/session events that can strip
   * WDA_EXCLUDEFROMCAPTURE: display wake, monitor connect/disconnect,
   * session lock/unlock. Called by StealthManager after wiring the
   * relevant Electron events (powerMonitor, screen events).
   */
  forceReapply(): void {
    if (process.platform !== 'win32') {
      return;
    }
    void this.poll();
  }

  getMetrics(): { reapplyCount: number; failureCount: number } {
    return {
      reapplyCount: this.reapplyCount,
      failureCount: this.failureCount,
    };
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;

    try {
      const nativeModule = this.getNativeModule();
      if (!nativeModule?.isWindowsCaptureProtected || !nativeModule?.applyWindowsWindowStealth) {
        return;
      }

      const now = Date.now();
      const managed = this.stealthManager.getManagedWindowEntries();

      // Clean up state for windows that are no longer managed
      const activeIds = new Set(managed.map((entry) => entry.id));
      for (const id of this.windowState.keys()) {
        if (!activeIds.has(id)) {
          this.windowState.delete(id);
        }
      }

      for (const entry of managed) {
        const handle = entry.getNativeWindowHandle?.();
        if (!handle) {
          continue;
        }

        let state = this.windowState.get(entry.id);
        if (!state) {
          state = { consecutiveFailures: 0, backoffUntil: 0 };
          this.windowState.set(entry.id, state);
        }

        if (state.backoffUntil > now) {
          continue;
        }

        try {
          const isProtected = nativeModule.isWindowsCaptureProtected(handle);
          if (isProtected) {
            state.consecutiveFailures = 0;
            state.backoffUntil = 0;
            continue;
          }

          this.logger.warn(
            `[WindowsCaptureEnforcementLoop] Capture protection lost for window ${entry.id}, re-applying`,
          );
          this.reapplyCount += 1;

          try {
            nativeModule.applyWindowsWindowStealth(handle);
            // Re-apply ancillary layers if available
            nativeModule.applyWindowsAltTabExclusion?.(handle);
            // DWM cloak only re-applied if it was already applied — caller
            // controls cloak via feature flag, not the enforcement loop.

            const verified = nativeModule.isWindowsCaptureProtected(handle);
            if (verified) {
              state.consecutiveFailures = 0;
              state.backoffUntil = 0;
              continue;
            }
          } catch (applyError) {
            this.logger.warn(
              `[WindowsCaptureEnforcementLoop] Re-apply failed for window ${entry.id}:`,
              applyError,
            );
          }

          state.consecutiveFailures += 1;
          this.failureCount += 1;

          if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            state.backoffUntil = now + PERSISTENT_FAILURE_BACKOFF_MS;
            this.logger.warn(
              `[WindowsCaptureEnforcementLoop] Persistent failure for window ${entry.id} — engaging fail-closed`,
            );
            // Tell the StealthManager to engage privacy shield / hide the
            // window. The manager already knows how to do this for
            // capture-risk warnings via its addWarning -> derivePrivacyShieldState path.
            this.stealthManager.recordCaptureProtectionFailure(entry.id);
            state.consecutiveFailures = 0;
          }
        } catch (error) {
          this.logger.warn(
            `[WindowsCaptureEnforcementLoop] Verification error for window ${entry.id}:`,
            error,
          );
          state.consecutiveFailures += 1;
          this.failureCount += 1;
          if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            state.backoffUntil = now + PERSISTENT_FAILURE_BACKOFF_MS;
            this.stealthManager.recordCaptureProtectionFailure(entry.id);
            state.consecutiveFailures = 0;
          }
        }
      }

      Metrics.gauge('stealth.windows_capture_reapplies', this.reapplyCount);
      Metrics.gauge('stealth.windows_capture_failures', this.failureCount);
    } catch (error) {
      this.logger.warn('[WindowsCaptureEnforcementLoop] Poll failed:', error);
    } finally {
      this.polling = false;
    }
  }

  private getNativeModule(): NativeStealthBindings | null {
    if (this.nativeModuleOverride !== undefined) {
      return this.nativeModuleOverride;
    }
    return loadNativeStealthModule({ retryOnFailure: false });
  }
}
