import type { StealthState } from '../runtime/types';
import { hasCaptureRiskWarnings } from './privacyShieldState';

export interface PrivacyShieldRecoverySnapshot {
  isUndetectable: boolean;
  faultReason: string | null;
  warnings: readonly string[];
  stealthState: StealthState;
}

interface PrivacyShieldRecoveryControllerOptions {
  getSnapshot: () => PrivacyShieldRecoverySnapshot;
  recoverFullStealth: () => Promise<void>;
  recoveryDelayMs?: number;
  maxAutoRecoveryAttempts?: number;
  timeoutScheduler?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutScheduler?: (handle: unknown) => void;
  logger?: Pick<Console, 'log' | 'warn'>;
}

const DEFAULT_RECOVERY_DELAY_MS = 2000;
const DEFAULT_MAX_AUTO_RECOVERY_ATTEMPTS = 3;

function needsRecovery(snapshot: PrivacyShieldRecoverySnapshot): boolean {
  return snapshot.isUndetectable && snapshot.faultReason !== null && snapshot.stealthState === 'FAULT';
}

export class PrivacyShieldRecoveryController {
  private readonly getSnapshot: () => PrivacyShieldRecoverySnapshot;
  private readonly recoverFullStealth: () => Promise<void>;
  private readonly recoveryDelayMs: number;
  private readonly maxAutoRecoveryAttempts: number;
  private readonly timeoutScheduler: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutScheduler: (handle: unknown) => void;
  private readonly logger: Pick<Console, 'log' | 'warn'>;
  private recoveryHandle: unknown = null;
  private recoveryInFlight: Promise<void> | null = null;
  private autoRecoveryAttempts = 0;

  constructor(options: PrivacyShieldRecoveryControllerOptions) {
    this.getSnapshot = options.getSnapshot;
    this.recoverFullStealth = options.recoverFullStealth;
    this.recoveryDelayMs = options.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS;
    this.maxAutoRecoveryAttempts = options.maxAutoRecoveryAttempts ?? DEFAULT_MAX_AUTO_RECOVERY_ATTEMPTS;
    this.timeoutScheduler = options.timeoutScheduler ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutScheduler = options.clearTimeoutScheduler ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.logger = options.logger ?? console;
  }

  update(): void {
    const snapshot = this.getSnapshot();
    if (!needsRecovery(snapshot)) {
      this.reset();
      return;
    }

    if (hasCaptureRiskWarnings(snapshot.warnings)) {
      this.autoRecoveryAttempts = 0;
      this.cancelPendingRecovery();
      return;
    }

    if (
      this.recoveryInFlight !== null ||
      this.recoveryHandle !== null ||
      this.autoRecoveryAttempts >= this.maxAutoRecoveryAttempts
    ) {
      return;
    }

    this.recoveryHandle = this.timeoutScheduler(() => {
      this.recoveryHandle = null;
      void this.runAutoRecovery();
    }, this.recoveryDelayMs);

    const timeoutLikeHandle = this.recoveryHandle as { unref?: () => void };
    timeoutLikeHandle.unref?.();
  }

  async triggerManualRecovery(): Promise<boolean> {
    this.cancelPendingRecovery();
    return this.attemptRecovery('shortcut');
  }

  dispose(): void {
    this.reset();
  }

  private async runAutoRecovery(): Promise<void> {
    if (this.autoRecoveryAttempts >= this.maxAutoRecoveryAttempts) {
      return;
    }

    this.autoRecoveryAttempts += 1;
    await this.attemptRecovery('timeout');
  }

  private async attemptRecovery(source: 'shortcut' | 'timeout'): Promise<boolean> {
    const snapshot = this.getSnapshot();
    if (!needsRecovery(snapshot) || hasCaptureRiskWarnings(snapshot.warnings)) {
      return false;
    }

    // NAT-030: single-flight recovery — return existing promise if already in flight
    if (this.recoveryInFlight) {
      await this.recoveryInFlight;
      return true;
    }

    // Take atomic warning snapshot before recovery
    const preRecoveryWarnings = snapshot.warnings.slice();

    this.recoveryInFlight = this.runRecoveryBody(source, preRecoveryWarnings);
    try {
      await this.recoveryInFlight;
      return true;
    } catch {
      return false;
    }
  }

  private async runRecoveryBody(source: 'shortcut' | 'timeout', preRecoveryWarnings: readonly string[]): Promise<void> {
    try {
      await this.recoverFullStealth();
    } catch (error) {
      this.logger.warn(`[PrivacyShieldRecovery] ${source} recovery failed:`, error);
      throw error;
    } finally {
      this.recoveryInFlight = null;
      // NAT-030: re-check warnings after recovery; if capture-risk still present, keep shield
      const postSnapshot = this.getSnapshot();
      if (hasCaptureRiskWarnings(postSnapshot.warnings) || hasCaptureRiskWarnings(preRecoveryWarnings)) {
        // Do not clear attempts or shield while capture risk persists
        this.update();
        return;
      }
      if (!needsRecovery(postSnapshot)) {
        this.autoRecoveryAttempts = 0;
      }
      this.update();
    }
  }

  private cancelPendingRecovery(): void {
    if (this.recoveryHandle === null) {
      return;
    }

    this.clearTimeoutScheduler(this.recoveryHandle);
    this.recoveryHandle = null;
  }

  private reset(): void {
    this.autoRecoveryAttempts = 0;
    this.cancelPendingRecovery();
  }
}
