import type { StealthManager } from './StealthManager';
import type { MonitoringDetector, DetectedThreat } from './MonitoringDetector';
import type { SupervisorBus } from '../runtime/SupervisorBus';
import { gracefulShutdown } from '../GracefulShutdownManager';

export interface EnforcementLoopIntervals {
  windowProtectionMs: number; // 250ms
  processDetectionMs: number; // 3000ms
  disguiseValidationMs: number; // 15000ms
}

export interface EnforcementLoopOptions {
  stealthManager: StealthManager;
  monitoringDetector: MonitoringDetector;
  bus: SupervisorBus;
  intervals: EnforcementLoopIntervals;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  exitFn?: (code: number, reason: string) => void;
}

interface ViolationRecord {
  timestamp: number;
  type: string;
}

export class ContinuousEnforcementLoop {
  private readonly stealthManager: StealthManager;
  private readonly monitoringDetector: MonitoringDetector;
  private readonly bus: SupervisorBus;
  private readonly intervals: EnforcementLoopIntervals;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly exitFn: (code: number, reason: string) => void;

  private windowProtectionTimer: NodeJS.Timeout | null = null;
  private processDetectionTimer: NodeJS.Timeout | null = null;
  private disguiseValidationTimer: NodeJS.Timeout | null = null;
  private running = false;
  private windowProtectionRunning = false;
  private processDetectionRunning = false;
  private disguiseValidationRunning = false;

  // Violation ring buffer: if 3+ violations within 60s, trigger immediate quit
  private violations: ViolationRecord[] = [];
  private static readonly MAX_VIOLATIONS = 3;
  private static readonly VIOLATION_WINDOW_MS = 60000;

  constructor(options: EnforcementLoopOptions) {
    this.stealthManager = options.stealthManager;
    this.monitoringDetector = options.monitoringDetector;
    this.bus = options.bus;
    this.intervals = options.intervals;
    this.logger = options.logger ?? console;
    this.exitFn = options.exitFn ?? ((code: number, reason: string) => {
      gracefulShutdown.shutdown(code, reason).catch(() => {
        setTimeout(() => process.exit(code), 3000);
      });
    });
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

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

    this.logger.log('[ContinuousEnforcementLoop] Started');
  }

  stop(): void {
    this.running = false;

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

  private async handleCriticalThreat(threat: DetectedThreat): Promise<void> {
    this.logger.error(`[ContinuousEnforcementLoop] CRITICAL threat detected: ${threat.name} (PID: ${threat.pid})`);

    await this.bus.emit({
      type: 'stealth:fault',
      reason: `monitoring-tool-detected:${threat.name}`,
    });

    // Kill switch: exit within 1 second
    this.exitFn(1, `monitoring-tool-detected:${threat.name}`);
  }

  private async handleWarningThreat(threat: DetectedThreat): Promise<void> {
    this.logger.warn(`[ContinuousEnforcementLoop] Warning threat detected: ${threat.name} (PID: ${threat.pid})`);

    // Emit event that StealthManager handles for hiding windows
    await this.bus.emit({
      type: 'stealth:fault',
      reason: `screen-capture-tool-detected:${threat.name}`,
    });

    // Trigger window protection via stealth manager's internal watchdog mechanism
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
      this.exitFn(1, 'max-violations-exceeded');
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
