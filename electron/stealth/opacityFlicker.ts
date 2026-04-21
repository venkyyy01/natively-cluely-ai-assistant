import { Metrics } from '../runtime/Metrics';
import type { StealthCapableWindow, ManagedWindowRecord } from './stealthTypes';

export interface OpacityFlickerDeps {
  isEnabled: () => boolean;
  isEnhancedStealthEnabled: () => boolean;
  platform: string;
  isMacOS15Plus: boolean;
  featureFlags: { enableOpacityFlicker?: boolean };
  intervalScheduler: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalScheduler: (handle: unknown) => void;
  logger: Pick<Console, 'log' | 'warn'>;
  managedWindows: Set<ManagedWindowRecord>;
  isWindowDestroyed: (win: StealthCapableWindow) => boolean;
  timeoutScheduler: (callback: () => void, delayMs: number) => unknown;
}

export class OpacityFlickerController {
  private handle: unknown = null;

  constructor(private deps: OpacityFlickerDeps) {}

  ensure(): void {
    if (
      this.handle ||
      !this.deps.isEnabled() ||
      !this.deps.isEnhancedStealthEnabled() ||
      this.deps.platform !== 'darwin' ||
      !this.deps.isMacOS15Plus
    ) {
      return;
    }

    if (!this.deps.featureFlags.enableOpacityFlicker) {
      return;
    }

    this.handle = this.deps.intervalScheduler(
      () => this.apply(),
      500
    );
    Metrics.gauge('stealth.flicker_active', 1);
    this.deps.logger.log('[StealthManager] macOS 15.4+ opacity flicker enabled (500ms interval)');
  }

  stop(): void {
    if (this.handle) {
      this.deps.clearIntervalScheduler(this.handle);
      this.handle = null;
      Metrics.gauge('stealth.flicker_active', 0);
    }
  }

  private apply(): void {
    for (const record of this.deps.managedWindows) {
      const win = record.win;
      if (this.deps.isWindowDestroyed(win)) {
        continue;
      }

      if (typeof win.setOpacity === 'function') {
        try {
          win.setOpacity(0.999);
          this.deps.timeoutScheduler(() => {
            if (!this.deps.isWindowDestroyed(win) && typeof win.setOpacity === 'function') {
              win.setOpacity(1);
            }
          }, 30);
        } catch (error) {
          this.deps.logger.warn('[StealthManager] Opacity flicker failed, continuing with Layer 0+1:', error);
        }
      }
    }
  }
}
