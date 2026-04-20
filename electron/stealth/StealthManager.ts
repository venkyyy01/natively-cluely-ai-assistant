import { Metrics } from '../runtime/Metrics';
import { isOptimizationActive } from '../config/optimizations';
import { EventEmitter } from 'events';
import type { VirtualDisplayCoordinator } from './MacosVirtualDisplayClient';

import { loadNativeStealthModule } from './nativeStealthModule';
import { execFile } from 'node:child_process';
import { ChromiumCaptureDetector } from './ChromiumCaptureDetector';
import { MacosStealthEnhancer } from './MacosStealthEnhancer';
import { TCCMonitor } from './TCCMonitor';

export interface StealthConfig {
  enabled: boolean;
}

export interface StealthWindowOptions {
  contentProtection: boolean;
  skipTaskbar: boolean;
  excludeFromCapture: boolean;
}

export interface PlatformCapabilities {
  platform: string;
  supportsContentProtection: boolean;
  supportsNativeExclusion: boolean;
}

export interface NativeStealthBindings {
  applyMacosWindowStealth?: (windowNumber: number) => void;
  applyMacosPrivateWindowStealth?: (windowNumber: number) => void;
  removeMacosWindowStealth?: (windowNumber: number) => void;
  removeMacosPrivateWindowStealth?: (windowNumber: number) => void;
  verifyMacosStealthState?: (windowNumber: number) => number;
  applyWindowsWindowStealth?: (handle: Buffer) => void;
  removeWindowsWindowStealth?: (handle: Buffer) => void;
  verifyWindowsStealthState?: (handle: Buffer) => number;
}

export interface StealthFeatureFlags {
  enablePrivateMacosStealthApi?: boolean;
  enableCaptureDetectionWatchdog?: boolean;
  enableVirtualDisplayIsolation?: boolean;
  enableSCStreamDetection?: boolean;
  /**
   * NAT-010 / audit S-1: gates the periodic 500 ms opacity-flicker loop on
   * macOS 15.4+. Off by default because the deterministic 500 ms cadence is
   * itself a fingerprint that defeats the supposed stealth gain. Reserved
   * for ad-hoc capture-bypass test fixtures (see NAT-082).
   */
  enableOpacityFlicker?: boolean;
}

export type StealthWindowRole = 'primary' | 'auxiliary';

export interface StealthApplyOptions {
  role?: StealthWindowRole;
  hideFromSwitcher?: boolean;
  allowVirtualDisplayIsolation?: boolean;
}

type DisplayBounds = { x: number; y: number; width: number; height: number };
type DisplayInfo = { id: number; workArea: DisplayBounds };
type DisplayEventSource = { on: (event: string, listener: () => void) => void };
type ScreenApi = DisplayEventSource & { getAllDisplays: () => DisplayInfo[] };

interface StealthManagerDependencies {
  nativeModule?: NativeStealthBindings | null;
  platform?: string;
  powerMonitor?: { on: (event: string, listener: () => void) => void } | null;
  displayEvents?: DisplayEventSource | null;
  screenApi?: ScreenApi | null;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  featureFlags?: StealthFeatureFlags;
  intervalScheduler?: (callback: () => Promise<void> | void, intervalMs: number) => unknown;
  clearIntervalScheduler?: (handle: unknown) => void;
  timeoutScheduler?: (callback: () => void, delayMs: number) => unknown;
  virtualDisplayCoordinator?: VirtualDisplayCoordinator | null;
  captureToolPatterns?: RegExp[];
  processEnumerator?: (command: string, args: string[]) => Promise<string>;
}

interface StealthCapableWindow {
  on?: (event: string, listener: () => void) => void;
  setContentProtection: (value: boolean) => void;
  setExcludeFromCapture?: (value: boolean) => void;
  setHiddenInMissionControl?: (value: boolean) => void;
  setExcludedFromShownWindowsMenu?: (value: boolean) => void;
  setSkipTaskbar?: (value: boolean) => void;
  setOpacity?: (value: number) => void;
  setBounds?: (bounds: { x: number; y: number; width: number; height: number }) => void;
  hide?: () => void;
  show?: () => void;
  getNativeWindowHandle?: () => Buffer;
  getMediaSourceId?: () => string;
  getBounds?: () => { x: number; y: number; width: number; height: number };
  isVisible?: () => boolean;
  isDestroyed?: () => boolean;
}

interface ManagedWindowRecord {
  win: StealthCapableWindow;
  role: StealthWindowRole;
  hideFromSwitcher: boolean;
  allowVirtualDisplayIsolation: boolean;
  listenersAttached: boolean;
  virtualDisplayRequestId: number;
  virtualDisplayIsolationStarted: boolean;
  privateMacosStealthApplied: boolean;
}

const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_RESTORE_DELAY_MS = 500;
const DISPLAY_MOVE_RETRY_DELAY_MS = 100;
const DISPLAY_MOVE_MAX_RETRIES = 10;
const SCSTREAM_CHECK_INTERVAL_MS = 500;
const CGWINDOW_VISIBILITY_CHECK_MS = 500;
const KNOWN_CAPTURE_TOOL_PATTERNS = [
  /obs/i,
  /zoom\.us/i,
  /zoom/i,
  /microsoft teams/i,
  /teams2/i,
  /teams for enterprise/i,
  /meet/i,
  /webex/i,
  /snipping/i,
  /screen ?studio/i,
  /quicktime/i,
  /loom/i,
  /capture/i,
  /sharex/i,
  /greenshot/i,
  /flameshot/i,
  /discord/i,
  /slack/i,
  /ffmpeg/i,
  /screencapture/i,
  /vnc/i,
  /anydesk/i,
  /teamviewer/i,
  /screen ?recorder/i,
  /camtasia/i,
  /bandicam/i,
  /printwindow/i,
  /chrome/i,
  /chromium/i,
  /msedge/i,
  /microsoft edge/i,
  /brave/i,
  /nvidia/i,
  /shadowplay/i,
  /geforce/i,
  /gamebar/i,
  /xbox/i,
  /skype/i,
  /gotomeeting/i,
  /goto/i,
  /bluejeans/i,
  /jitsi/i,
  /screenshot/i,
  /parallels/i,
  /vmware/i,
  /rdpclip/i,
  /mstsc/i,
  /remote desktop/i,
  /parsec/i,
  /nomachine/i,
  /distant/i,
  /screenrecording/i,
  /screencasting/i,
  /airplay/i,
  /coreaudiod/i,
  /facet/i,
  /gather/i,
  /teramind/i,
  /activtrak/i,
  /time doctor/i,
  /hubstaff/i,
  /workpuls/i,
  /idletime/i,
  /screencastify/i,
  /vidyard/i,
  /wistia/i,
];

function scheduleUnrefInterval(callback: () => Promise<void> | void, intervalMs: number): NodeJS.Timeout {
  const handle = setInterval(callback, intervalMs);
  handle.unref?.();
  return handle;
}

function scheduleUnrefTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}

function defaultProcessEnumerator(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (!error) {
        resolve(stdout);
        return;
      }

      const err = error as NodeJS.ErrnoException & { code?: number };
      if (command === 'pgrep' && err.code === 1) {
        resolve('');
        return;
      }

      reject(error);
    });
  });
}

export class StealthManager extends EventEmitter {
  private config: StealthConfig;
  private stealthDegradationWarnings = new Set<string>();

  public getStealthDegradationWarnings(): string[] {
    return Array.from(this.stealthDegradationWarnings);
  }

  private addWarning(warning: string): void {
    if (!this.stealthDegradationWarnings.has(warning)) {
      this.stealthDegradationWarnings.add(warning);
      this.emit('stealth-degraded', this.getStealthDegradationWarnings());
    }
  }

  private clearWarning(warning: string): void {
    if (this.stealthDegradationWarnings.has(warning)) {
      this.stealthDegradationWarnings.delete(warning);
      this.emit('stealth-degraded', this.getStealthDegradationWarnings());
    }
  }
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly powerMonitor: { on: (event: string, listener: () => void) => void } | null;
  private readonly displayEvents: DisplayEventSource | null;
  private readonly screenApi: ScreenApi | null;
  private readonly featureFlags: StealthFeatureFlags;
  private readonly intervalScheduler: (callback: () => Promise<void> | void, intervalMs: number) => unknown;
  private readonly clearIntervalScheduler: (handle: unknown) => void;
  private readonly timeoutScheduler: (callback: () => void, delayMs: number) => unknown;
  private readonly virtualDisplayCoordinator: VirtualDisplayCoordinator | null;
  private readonly captureToolPatterns: RegExp[];
  private readonly processEnumerator: (command: string, args: string[]) => Promise<string>;
  private readonly managedWindows = new Set<ManagedWindowRecord>();
  private readonly managedWindowLookup = new WeakMap<object, ManagedWindowRecord>();
  private nativeModule: NativeStealthBindings | null | undefined;
  private powerMonitorBound = false;
  private displayEventsBound = false;
  private watchdogHandle: unknown = null;
  private windowsAffinityHandle: unknown = null;
  private watchdogRunning = false;
  private watchdogPauseTokens = new Set<string>();
  private watchdogStateVersion = 0;
  private meetingActive = false;
  private scStreamMonitorHandle: unknown = null;
  private scStreamMonitorRunning = false;
  private scStreamActive = false;
  private captureVisibleToToolsActive = false;
  private chromiumDetector: ChromiumCaptureDetector | null = null;
  private stealthEnhancer: MacosStealthEnhancer | null = null;
  private cgWindowMonitorHandle: unknown = null;
  private cgWindowMonitorRunning = false;
  private tccMonitor: TCCMonitor | null = null;
  private isMacOS15Plus = false;
  private macOSMajor: number = 0;
  private macOSMinor: number = 0;
  private opacityFlickerHandle: unknown = null;
  private virtualDisplayTaskQueue: Promise<void> | null = null;

  constructor(config: StealthConfig, deps: StealthManagerDependencies = {}) {
    super();
    this.config = config;
    this.platform = deps.platform ?? process.platform;
    this.logger = deps.logger ?? console;
    this.powerMonitor = deps.powerMonitor ?? this.resolvePowerMonitor();
    this.screenApi = deps.screenApi ?? this.resolveScreenApi();
    this.displayEvents = deps.displayEvents ?? this.resolveDisplayEvents(this.screenApi);
    this.featureFlags = deps.featureFlags ?? {};
    this.intervalScheduler = deps.intervalScheduler ?? scheduleUnrefInterval;
    this.clearIntervalScheduler = deps.clearIntervalScheduler ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.timeoutScheduler = deps.timeoutScheduler ?? scheduleUnrefTimeout;
    this.virtualDisplayCoordinator = deps.virtualDisplayCoordinator ?? null;
    this.captureToolPatterns = deps.captureToolPatterns ?? KNOWN_CAPTURE_TOOL_PATTERNS;
    this.processEnumerator = deps.processEnumerator ?? defaultProcessEnumerator;
    this.nativeModule = deps.nativeModule;
    this.detectMacOSVersion();
  }

  private detectMacOSVersion(): void {
    if (this.platform !== 'darwin') {
      return;
    }

    try {
      const { execSync } = require('child_process');
      const version = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
      const [major, minor = 0] = version.split('.').map((part: string) => Number.parseInt(part, 10) || 0);
      this.isMacOS15Plus = major > 15 || (major === 15 && minor >= 4);
      this.logger.log(`[StealthManager] macOS version: ${version}, 15.4+ screen capture bypass: ${this.isMacOS15Plus}`);
      
      // Store parsed version for later checks
      this.macOSMajor = major;
      this.macOSMinor = minor;
    } catch (error) {
      this.logger.warn('[StealthManager] Failed to detect macOS version:', error);
      this.isMacOS15Plus = false;
      this.macOSMajor = 0;
      this.macOSMinor = 0;
    }
  }

  private isMacOSVersionCompatible(minVersion: string): boolean {
    if (this.platform !== 'darwin') {
      return false;
    }

    const [requiredMajor = 0, requiredMinor = 0] = minVersion
      .split('.')
      .map((part: string) => Number.parseInt(part, 10) || 0);
    if (!requiredMajor) {
      return false;
    }

    const currentMajor = this.macOSMajor || 0;
    const currentMinor = this.macOSMinor || 0;

    return currentMajor > requiredMajor || (currentMajor === requiredMajor && currentMinor >= requiredMinor);
  }

  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled };
    if (!enabled) {
      this.stopBackgroundMonitorsIfIdle();
    }
  }

  getBrowserWindowOptions(): StealthWindowOptions {
    const enabled = this.isEnabled();

    return {
      contentProtection: enabled,
      skipTaskbar: false,
      excludeFromCapture: enabled,
    };
  }

  getPlatformCapabilities(): PlatformCapabilities {
    return {
      platform: this.platform,
      supportsContentProtection: this.platform === 'darwin' || this.platform === 'win32',
      supportsNativeExclusion: this.platform === 'darwin' || this.platform === 'win32',
    };
  }

  applyToWindow(
    win: StealthCapableWindow,
    enable: boolean = this.isEnabled(),
    options: StealthApplyOptions = {}
  ): void {
    if (!win || this.isWindowDestroyed(win)) {
      return;
    }

    if (!enable) {
      const record = this.managedWindowLookup.get(win as object);
      if (!record) {
        return;
      }

      this.removeNativeStealth(win);
      this.disableVirtualDisplayIsolation(record);
      // Layer 0 (setContentProtection + setExcludeFromCapture) is never disabled
      // once applied — it remains active regardless of stealth enable state.
      this.applyUiHardening(win, record.hideFromSwitcher);
      return;
    }

    if (!this.isEnabled()) {
      return;
    }

    const record = this.getOrCreateRecord(win, options);
    record.role = options.role ?? record.role;
    record.hideFromSwitcher = options.hideFromSwitcher ?? this.defaultHideFromSwitcher(record.role);
    record.allowVirtualDisplayIsolation = options.allowVirtualDisplayIsolation ?? record.allowVirtualDisplayIsolation;

    this.applyLayer0(win, true);
    this.applyUiHardening(win, record.hideFromSwitcher);
    this.applyNativeStealth(win);
    if (record.allowVirtualDisplayIsolation) {
      this.ensureVirtualDisplayIsolation(record);
    } else {
      this.disableVirtualDisplayIsolation(record);
    }
    this.attachLifecycleListeners(record);
    this.bindPowerMonitor();
    this.bindDisplayEvents();
    this.ensureWatchdog();
    this.ensureSCStreamMonitor();
    this.ensureChromiumDetection();
    this.ensureCGWindowMonitor();
    this.ensureTCCMonitor();
    this.ensureOpacityFlicker();
  }

  private ensureChromiumDetection(): void {
    if (
      !this.isEnabled() ||
      !this.isEnhancedStealthEnabled() ||
      this.platform !== 'darwin'
    ) {
      return;
    }

    if (!this.chromiumDetector) {
      this.chromiumDetector = new ChromiumCaptureDetector({
        platform: this.platform,
        checkIntervalMs: 500,
        logger: this.logger,
      });

      this.chromiumDetector.on('browser-detected', (info) => {
        this.logger.log(`[StealthManager] Chromium browser detected: ${info.name} (PID: ${info.pid})`);
        this.addWarning('chromium_browser_detected');
      });

      this.chromiumDetector.on('capture-active', () => {
        this.logger.log('[StealthManager] Chromium-based screen capture detected - activating countermeasures');
        this.applyChromiumCountermeasures();
        this.addWarning('chromium_capture_active');
      });

      this.chromiumDetector.on('capture-inactive', () => {
        this.logger.log('[StealthManager] Chromium-based screen capture ended');
        this.clearWarning('chromium_capture_active');
      });

      this.chromiumDetector.start();
    }
  }

  private applyChromiumCountermeasures(): void {
    for (const record of this.managedWindows) {
      const win = record.win;
      if (this.isWindowDestroyed(win)) {
        continue;
      }

      this.applyLayer0(win, true);
      this.applyNativeStealth(win);

      if (!this.stealthEnhancer) {
        this.stealthEnhancer = new MacosStealthEnhancer({
          platform: this.platform,
          logger: this.logger,
        });
      }

      const windowNumber = this.getMacosWindowNumber(win);
      if (windowNumber !== null) {
        void this.stealthEnhancer.enhanceWindowProtection(windowNumber);
      }

      // NAT-027: rely on Layer 0/1 reapply + privacy-shield ramp instead of win.hide()
      this.logger.log('[StealthManager] Reapplied stealth layers due to capture detection');
    }
  }

  reapplyAfterShow(win: StealthCapableWindow): void {
    if (!win || this.isWindowDestroyed(win) || !this.isEnabled()) {
      return;
    }

    const record = this.managedWindowLookup.get(win as object);
    if (!record) {
      return;
    }

    try {
      this.applyToWindow(win, true, {
        role: record.role,
        hideFromSwitcher: record.hideFromSwitcher,
        allowVirtualDisplayIsolation: record.allowVirtualDisplayIsolation,
      });
    } catch (error) {
      this.logger.warn('[StealthManager] reapplyAfterShow failed, maintaining Layer 0 protection:', error);
      this.applyLayer0(win, true);
    }
  }

  public isEnabled(): boolean {
    return this.config.enabled || this.meetingActive;
  }

  public setMeetingActive(active: boolean): void {
    this.meetingActive = active;

    if (active) {
      // Force Layer 0 on all managed windows when a meeting is active
      for (const record of this.managedWindows) {
        const win = record.win;
        if (this.isWindowDestroyed(win)) {
          continue;
        }
        this.applyLayer0(win, true);
      }
    }
  }

  public pauseWatchdog(token: string = 'default'): void {
    this.watchdogPauseTokens.add(token);
    this.watchdogStateVersion++;
  }

  public resumeWatchdog(token: string = 'default'): void {
    if (this.watchdogPauseTokens.has(token)) {
      this.watchdogPauseTokens.delete(token);
      this.watchdogStateVersion++;
    }
  }

  public verifyManagedWindows(): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    this.pauseWatchdog('verification');

    try {
      let verifiedVisibleWindowCount = 0;
      let hiddenWindowCount = 0;

      for (const record of this.managedWindows) {
        const win = record.win;
        if (this.isWindowDestroyed(win)) {
          continue;
        }

        const isVisible = typeof win.isVisible !== 'function' || win.isVisible();
        if (isVisible) {
          verifiedVisibleWindowCount += 1;
        } else {
          hiddenWindowCount += 1;
        }

        // NAT-029: hidden windows still run verifyStealth; only the visibility gate is removed
        if (!this.verifyStealth(win)) {
          return false;
        }
      }

      if (verifiedVisibleWindowCount === 0 && hiddenWindowCount > 0) {
        return true;
      }

      return verifiedVisibleWindowCount > 0;
    } finally {
      this.resumeWatchdog('verification');
    }
  }

  private isEnhancedStealthEnabled(): boolean {
    return isOptimizationActive('useStealthMode');
  }

  private applyLayer0(win: StealthCapableWindow, enable: boolean): void {
    try {
      win.setContentProtection(enable);
    } catch (error) {
      this.logger.warn('[StealthManager] setContentProtection failed:', error);
    }

    if (typeof win.setExcludeFromCapture === 'function') {
      try {
        win.setExcludeFromCapture(enable);
      } catch (error) {
        this.logger.warn('[StealthManager] setExcludeFromCapture failed:', error);
      }
    }
  }

  private applyUiHardening(win: StealthCapableWindow, hideFromSwitcher: boolean): void {
    if (typeof win.setSkipTaskbar === 'function') {
      try {
        win.setSkipTaskbar(hideFromSwitcher);
      } catch (error) {
        this.logger.warn('[StealthManager] setSkipTaskbar failed:', error);
      }
    }

    if (this.platform !== 'darwin') {
      return;
    }

    if (typeof win.setHiddenInMissionControl === 'function') {
      try {
        win.setHiddenInMissionControl(hideFromSwitcher);
      } catch (error) {
        this.logger.warn('[StealthManager] setHiddenInMissionControl failed:', error);
      }
    }

    if (typeof win.setExcludedFromShownWindowsMenu === 'function') {
      try {
        win.setExcludedFromShownWindowsMenu(hideFromSwitcher);
      } catch (error) {
        this.logger.warn('[StealthManager] setExcludedFromShownWindowsMenu failed:', error);
      }
    }
  }

  private applyNativeStealth(win: StealthCapableWindow): void {
    const nativeModule = this.getNativeModule();
    const record = this.managedWindowLookup.get(win as object);
    if (!nativeModule) {
      if (record) {
        record.privateMacosStealthApplied = false;
      }
      return;
    }

    try {
      if (this.platform === 'win32' && nativeModule.applyWindowsWindowStealth) {
        const handle = win.getNativeWindowHandle?.();
        if (handle) {
          nativeModule.applyWindowsWindowStealth(handle);
          this.verifyStealth(win);
        }
        return;
      }

      if (this.platform === 'darwin' && nativeModule.applyMacosWindowStealth) {
        const windowNumber = this.getMacosWindowNumber(win);
        if (windowNumber !== null) {
          if (record) {
            record.privateMacosStealthApplied = false;
          }
          nativeModule.applyMacosWindowStealth(windowNumber);
          
          if (this.featureFlags.enablePrivateMacosStealthApi && nativeModule.applyMacosPrivateWindowStealth) {
            if (this.isMacOSVersionCompatible('15.0')) {
              try {
                nativeModule.applyMacosPrivateWindowStealth(windowNumber);
                if (record) {
                  record.privateMacosStealthApplied = true;
                }
              } catch (privateError) {
                this.logger.warn('[StealthManager] Private macOS stealth API failed (incompatible version), falling back to Layer 0:', privateError);
                this.addWarning('private_api_failed');
              }
            } else {
              this.logger.warn('[StealthManager] macOS version < 15.0, skipping private API');
            }
          }
          
          this.verifyStealth(win);
        }
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Native stealth application failed, falling back to Layer 0 (setContentProtection):', error);
      if (this.isEnabled()) this.addWarning('native_stealth_failed');
    }
  }

  private removeNativeStealth(win: StealthCapableWindow): void {
    const nativeModule = this.getNativeModule();
    const record = this.managedWindowLookup.get(win as object);
    if (record) {
      record.privateMacosStealthApplied = false;
    }
    if (!nativeModule) {
      return;
    }

    try {
      if (this.platform === 'win32' && nativeModule.removeWindowsWindowStealth) {
        const handle = win.getNativeWindowHandle?.();
        if (handle) {
          nativeModule.removeWindowsWindowStealth(handle);
        }
        return;
      }

      if (this.platform === 'darwin' && nativeModule.removeMacosWindowStealth) {
        const windowNumber = this.getMacosWindowNumber(win);
        if (windowNumber !== null) {
          nativeModule.removeMacosWindowStealth(windowNumber);
          if (this.featureFlags.enablePrivateMacosStealthApi && nativeModule.removeMacosPrivateWindowStealth) {
            nativeModule.removeMacosPrivateWindowStealth(windowNumber);
          }
        }
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Native stealth removal failed:', error);
    }
  }

  private getMacosWindowNumber(win: StealthCapableWindow): number | null {
    const mediaSourceId = this.safeGetMediaSourceId(win);
    if (!mediaSourceId) {
      return null;
    }

    const parts = mediaSourceId.split(':');
    if (parts.length < 2) {
      return null;
    }

    const parsed = Number(parts[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private ensureVirtualDisplayIsolation(record: ManagedWindowRecord): void {
    if (
      this.platform !== 'darwin' ||
      !this.featureFlags.enableVirtualDisplayIsolation ||
      !this.isEnhancedStealthEnabled() ||
      !this.virtualDisplayCoordinator ||
      !record.allowVirtualDisplayIsolation ||
      record.virtualDisplayIsolationStarted
    ) {
      return;
    }

    const coordinator = this.virtualDisplayCoordinator;
    if (!coordinator) {
      return;
    }
    const win = record.win;
    const windowId = this.safeGetMediaSourceId(win);
    if (!windowId) {
      return;
    }

    const requestId = record.virtualDisplayRequestId + 1;
    record.virtualDisplayRequestId = requestId;
    record.virtualDisplayIsolationStarted = true;

    this.enqueueVirtualDisplayTask(async () => {
      if (!this.isCurrentVirtualDisplayRequest(record, requestId) || this.isWindowDestroyed(win)) {
        return;
      }

      try {
        const response = await coordinator.ensureIsolationForWindow({
          sessionId: windowId,
          windowId,
          width: win.getBounds?.().width ?? 0,
          height: win.getBounds?.().height ?? 0,
        });

        if (!this.isCurrentVirtualDisplayRequest(record, requestId)) {
          return;
        }

        if (!response.ready || !response.surfaceToken) {
          record.virtualDisplayIsolationStarted = false;
          this.logger.warn('[StealthManager] Virtual display isolation not ready, falling back to Layer 0+1');
          if (this.isEnabled()) this.addWarning('virtual_display_failed');
          return;
        }

        this.clearWarning('virtual_display_failed');
        this.clearWarning('virtual_display_exhausted');

        this.moveWindowToVirtualDisplay(record, response.surfaceToken, requestId);
      } catch (error) {
        if (this.isCurrentVirtualDisplayRequest(record, requestId)) {
          record.virtualDisplayIsolationStarted = false;
        }
        this.logger.warn('[StealthManager] Virtual display isolation failed, falling back to Layer 0+1:', error);
        if (this.isEnabled()) {
          if (coordinator.isExhausted?.()) {
            this.addWarning('virtual_display_exhausted');
          } else {
            this.addWarning('virtual_display_failed');
          }
        }
      }
    });
  }

  private enqueueVirtualDisplayTask(task: () => Promise<void>): void {
    const runTask = async (): Promise<void> => {
      await task();
    };
    const activeQueue = this.virtualDisplayTaskQueue;
    const next = activeQueue ? activeQueue.then(runTask, runTask) : runTask();
    const trackedQueue = next.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.virtualDisplayTaskQueue = trackedQueue;
    void trackedQueue.finally(() => {
      if (this.virtualDisplayTaskQueue === trackedQueue) {
        this.virtualDisplayTaskQueue = null;
      }
    });
  }

  private disableVirtualDisplayIsolation(record: ManagedWindowRecord): void {
    record.virtualDisplayRequestId += 1;
    if (!record.virtualDisplayIsolationStarted) {
      return;
    }

    record.virtualDisplayIsolationStarted = false;
    this.releaseVirtualDisplayIsolation(record.win);
  }

  private releaseVirtualDisplayIsolation(win: StealthCapableWindow): void {
    if (
      this.platform !== 'darwin' ||
      !this.featureFlags.enableVirtualDisplayIsolation ||
      !this.virtualDisplayCoordinator
    ) {
      return;
    }

    const windowId = this.safeGetMediaSourceId(win);
    if (!windowId) {
      return;
    }

    this.virtualDisplayCoordinator.releaseIsolationForWindow({ windowId }).catch((error) => {
      this.logger.warn('[StealthManager] Virtual display isolation release failed, continuing with Layer 0+1:', error);
    });
  }

  private getOrCreateRecord(win: StealthCapableWindow, options: StealthApplyOptions): ManagedWindowRecord {
    const existing = this.managedWindowLookup.get(win as object);
    if (existing) {
      return existing;
    }

    const record: ManagedWindowRecord = {
      win,
      role: options.role ?? 'primary',
      hideFromSwitcher: options.hideFromSwitcher ?? this.defaultHideFromSwitcher(options.role ?? 'primary'),
      allowVirtualDisplayIsolation: options.allowVirtualDisplayIsolation ?? false,
      listenersAttached: false,
      virtualDisplayRequestId: 0,
      virtualDisplayIsolationStarted: false,
      privateMacosStealthApplied: false,
    };
    this.managedWindows.add(record);
    this.managedWindowLookup.set(win as object, record);
    return record;
  }

  private attachLifecycleListeners(record: ManagedWindowRecord): void {
    if (record.listenersAttached || typeof record.win.on !== 'function') {
      return;
    }

    const reapply = () => this.reapplyAfterShow(record.win);
    record.win.on('restore', reapply);
    record.win.on('unminimize', reapply);
    record.win.on('move', reapply);
    record.win.on('show', reapply);
    record.win.on('closed', () => {
      this.disableVirtualDisplayIsolation(record);
      this.managedWindows.delete(record);
      this.managedWindowLookup.delete(record.win as object);

      this.stopBackgroundMonitorsIfIdle();
    });
    record.listenersAttached = true;
  }

  private safeGetMediaSourceId(win: StealthCapableWindow): string | null {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
      return null;
    }

    try {
      return win.getMediaSourceId?.() ?? null;
    } catch (error) {
      this.logger.warn('[StealthManager] Failed to read media source id from managed window:', error);
      return null;
    }
  }

  private stopBackgroundMonitorsIfIdle(): void {
    if (this.isEnabled() && this.managedWindows.size > 0) {
      return;
    }

    if (this.watchdogHandle) {
      this.clearIntervalScheduler(this.watchdogHandle);
      this.watchdogHandle = null;
    }

    if (this.windowsAffinityHandle) {
      this.clearIntervalScheduler(this.windowsAffinityHandle);
      this.windowsAffinityHandle = null;
    }

    if (this.scStreamMonitorHandle) {
      this.clearIntervalScheduler(this.scStreamMonitorHandle);
      this.scStreamMonitorHandle = null;
    }

    if (this.cgWindowMonitorHandle) {
      this.clearIntervalScheduler(this.cgWindowMonitorHandle);
      this.cgWindowMonitorHandle = null;
    }

    if (this.opacityFlickerHandle) {
      this.clearIntervalScheduler(this.opacityFlickerHandle);
      this.opacityFlickerHandle = null;
      Metrics.gauge('stealth.flicker_active', 0);
    }

    this.watchdogRunning = false;
    this.scStreamMonitorRunning = false;
    this.cgWindowMonitorRunning = false;
    this.scStreamActive = false;
    this.captureVisibleToToolsActive = false;
    this.clearTransientCaptureWarnings();

    if (this.chromiumDetector) {
      this.chromiumDetector.stop();
      this.chromiumDetector = null;
    }

    if (this.tccMonitor) {
      this.tccMonitor.stop();
      this.tccMonitor = null;
    }
  }

  private clearTransientCaptureWarnings(): void {
    this.clearWarning('chromium_capture_active');
    this.clearWarning('scstream_capture_detected');
    this.clearWarning('window_visible_to_capture');
  }

  private bindPowerMonitor(): void {
    if (this.powerMonitorBound || !this.powerMonitor) {
      return;
    }

    const reapplyAll = () => {
      if (!this.isEnabled()) {
        return;
      }

      for (const record of this.managedWindows) {
        this.reapplyAfterShow(record.win);
      }
    };

    this.powerMonitor.on('unlock-screen', reapplyAll);
    this.powerMonitor.on('resume', reapplyAll);
    if (this.platform === 'darwin') {
      this.powerMonitor.on('on-ac', reapplyAll);
      this.powerMonitor.on('on-battery', reapplyAll);
    }
    this.powerMonitorBound = true;
  }

  private bindDisplayEvents(): void {
    if (this.displayEventsBound || !this.displayEvents || (this.platform !== 'win32' && this.platform !== 'darwin')) {
      return;
    }

    const reapplyAll = () => {
      if (!this.isEnabled()) {
        return;
      }

      for (const record of this.managedWindows) {
        this.reapplyAfterShow(record.win);
      }
    };

    this.displayEvents.on('display-metrics-changed', reapplyAll);
    if (this.platform === 'darwin') {
      this.displayEvents.on('display-added', reapplyAll);
      this.displayEvents.on('display-removed', reapplyAll);
    }
    this.displayEventsBound = true;
  }

  private moveWindowToVirtualDisplay(record: ManagedWindowRecord, surfaceToken: string | undefined, requestId: number): void {
    const win = record.win;
    if (!surfaceToken || !this.screenApi || typeof win.setBounds !== 'function' || typeof win.getBounds !== 'function') {
      if (this.isCurrentVirtualDisplayRequest(record, requestId)) {
        record.virtualDisplayIsolationStarted = false;
        this.releaseVirtualDisplayIsolation(win);
      }
      return;
    }

    const match = /^display-(\d+)$/.exec(surfaceToken);
    if (!match) {
      if (this.isCurrentVirtualDisplayRequest(record, requestId)) {
        record.virtualDisplayIsolationStarted = false;
        this.releaseVirtualDisplayIsolation(win);
      }
      return;
    }

    const displayId = Number(match[1]);
    this.moveWindowToDisplay(record, displayId, 0, requestId);
  }

  private moveWindowToDisplay(record: ManagedWindowRecord, displayId: number, attempt: number, requestId: number): void {
    const win = record.win;
    if (!this.screenApi || typeof win.setBounds !== 'function' || typeof win.getBounds !== 'function' || this.isWindowDestroyed(win)) {
      return;
    }

    if (!this.isCurrentVirtualDisplayRequest(record, requestId)) {
      return;
    }

    const targetDisplay = this.screenApi.getAllDisplays().find((display) => display.id === displayId);
    if (!targetDisplay) {
      if (attempt >= DISPLAY_MOVE_MAX_RETRIES) {
        record.virtualDisplayIsolationStarted = false;
        this.releaseVirtualDisplayIsolation(win);
        this.logger.warn(`[StealthManager] Virtual display ${displayId} was not reported by Electron after ${DISPLAY_MOVE_MAX_RETRIES} retries`);
        return;
      }

      this.timeoutScheduler(() => {
        this.moveWindowToDisplay(record, displayId, attempt + 1, requestId);
      }, DISPLAY_MOVE_RETRY_DELAY_MS);
      return;
    }

    const bounds = win.getBounds();
    win.setBounds({
      x: targetDisplay.workArea.x,
      y: targetDisplay.workArea.y,
      width: bounds.width,
      height: bounds.height,
    });
  }

  private isCurrentVirtualDisplayRequest(record: ManagedWindowRecord, requestId: number): boolean {
    return record.virtualDisplayIsolationStarted && record.virtualDisplayRequestId === requestId;
  }

  private resolveScreenApi(): ScreenApi | null {
    try {
      const electron = require('electron') as { screen?: ScreenApi };
      return electron.screen?.getAllDisplays ? electron.screen : null;
    } catch {
      return null;
    }
  }

  private resolveDisplayEvents(screenApi: ScreenApi | null): DisplayEventSource | null {
    return screenApi && typeof screenApi.on === 'function' ? screenApi : null;
  }

  private ensureWatchdog(): void {
    if (
      this.watchdogHandle ||
      !this.isEnabled() ||
      !this.isEnhancedStealthEnabled() ||
      !this.featureFlags.enableCaptureDetectionWatchdog
    ) {
      return;
    }

    this.watchdogHandle = this.intervalScheduler(() => this.pollCaptureTools(), WATCHDOG_INTERVAL_MS);

    if (this.platform === 'win32' && !this.windowsAffinityHandle) {
      this.windowsAffinityHandle = this.intervalScheduler(() => this.verifyWindowsAffinity(), 1000);
    }
  }

  private async verifyWindowsAffinity(): Promise<void> {
    for (const record of this.managedWindows) {
      const win = record.win;
      if (this.isWindowDestroyed(win)) {
        continue;
      }

      const nativeModule = this.getNativeModule();
      if (!nativeModule?.verifyWindowsStealthState) {
        continue;
      }

      const handle = win.getNativeWindowHandle?.();
      if (!handle) {
        continue;
      }

      try {
        const affinity = nativeModule.verifyWindowsStealthState(handle);
        if (affinity !== 0x11 && affinity !== 0x01) {
          this.logger.log('[StealthManager] Windows display affinity was reset - reapplying');
          this.applyNativeStealth(win);
        }
      } catch {
        // Ignore verification errors
      }
    }
  }

  private async pollCaptureTools(): Promise<void> {
    if (this.watchdogRunning || this.watchdogPauseTokens.size > 0) {
      return;
    }

    const watchdogStateVersionAtStart = this.watchdogStateVersion;
    this.watchdogRunning = true;
    try {
      const suspiciousToolMatches = await this.detectCaptureProcesses();

      // Ignore stale detections if a screenshot or verification flow paused
      // the watchdog while this poll was already in flight.
      if (this.watchdogPauseTokens.size > 0 || this.watchdogStateVersion !== watchdogStateVersionAtStart) {
        return;
      }

      if (suspiciousToolMatches.length > 0) {
        this.logger.log(
          `[StealthManager] Capture watchdog detected suspicious tools running. Patterns triggered: ${suspiciousToolMatches.length}`
        );
        this.hideAndRestoreVisibleWindows();
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Capture watchdog poll failed:', error);
    } finally {
      this.watchdogRunning = false;
    }
  }

  private async detectCaptureProcesses(): Promise<RegExp[]> {
    if (this.platform === 'win32') {
      const stdout = await this.processEnumerator('tasklist', ['/FO', 'CSV', '/NH']);
      return this.captureToolPatterns.filter((pattern) => pattern.test(stdout));
    }

    if (this.platform === 'darwin') {
      const processSnapshot = await this.readDarwinProcessSnapshot();
      if (processSnapshot !== null) {
        return this.captureToolPatterns.filter((pattern) => pattern.test(processSnapshot));
      }

      const matches: RegExp[] = [];
      const browserPatterns = this.getBrowserCapturePatterns();
      const nonBrowserPatterns = this.captureToolPatterns.filter((p) => !browserPatterns.includes(p));

      for (const pattern of nonBrowserPatterns) {
        const stdout = await this.processEnumerator('pgrep', ['-lif', pattern.source]);
        if (pattern.test(stdout)) {
          matches.push(pattern);
        }
      }

      const browserStdout = await this.processEnumerator('pgrep', ['-lif', 'chrome|chromium|msedge|brave']);
      if (browserStdout) {
        const browserLines = browserStdout.trim().split('\n').filter(Boolean);
        for (const line of browserLines) {
          const appPathMatch = line.match(/\/(Chrome|Chromium|Microsoft Edge|Brave Browser)\.app\//i);
          if (appPathMatch) {
            const appName = appPathMatch[1].toLowerCase();
            for (const pattern of browserPatterns) {
              if (pattern.test(appName) && !matches.includes(pattern)) {
                matches.push(pattern);
              }
            }
          }
        }
      }

      return matches;
    }

    return [];
  }

  private async readDarwinProcessSnapshot(): Promise<string | null> {
    try {
      return await this.processEnumerator('ps', ['-A', '-o', 'command=']);
    } catch {
      return null;
    }
  }

  private getBrowserCapturePatterns(): RegExp[] {
    return [
      /chrome/i,
      /chromium/i,
      /msedge/i,
      /microsoft edge/i,
      /brave/i,
    ];
  }

  private async checkSCStreamActive(): Promise<boolean> {
    if (this.platform !== 'darwin') {
      return false;
    }

    try {
      const stdout = await this.processEnumerator('pgrep', ['-lf', 'ScreenCaptureAgent']);
      if (stdout && stdout.trim()) {
        return true;
      }

      const stdout2 = await this.processEnumerator('pgrep', ['-lf', 'controlcenter']);
      if (stdout2 && stdout2.trim()) {
        const controlCenterOutput = stdout2.toLowerCase();
        if (controlCenterOutput.includes('screen') || controlCenterOutput.includes('capture')) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private ensureSCStreamMonitor(): void {
    if (
      this.scStreamMonitorHandle ||
      !this.isEnabled() ||
      !this.isEnhancedStealthEnabled() ||
      !this.featureFlags.enableSCStreamDetection
    ) {
      return;
    }

    this.scStreamMonitorHandle = this.intervalScheduler(
      () => this.pollSCStreamState(),
      SCSTREAM_CHECK_INTERVAL_MS
    );
    this.logger.log('[StealthManager] SCStream capture monitor started');
  }

  private async pollSCStreamState(): Promise<void> {
    if (this.scStreamMonitorRunning) {
      return;
    }

    this.scStreamMonitorRunning = true;
    try {
      const isActive = await this.checkSCStreamActive();

      if (isActive && !this.scStreamActive) {
        this.scStreamActive = true;
        this.logger.log('[StealthManager] SCStream capture session detected - activating enhanced protection');
        this.applyEnhancedProtectionForSCStream();
        this.addWarning('scstream_capture_detected');
      } else if (!isActive && this.scStreamActive) {
        this.scStreamActive = false;
        this.logger.log('[StealthManager] SCStream capture session ended');
        this.clearWarning('scstream_capture_detected');
      }
    } catch (error) {
      this.logger.warn('[StealthManager] SCStream monitor poll failed, maintaining Layer 0 protection:', error);
    } finally {
      this.scStreamMonitorRunning = false;
    }
  }

  private applyEnhancedProtectionForSCStream(): void {
    for (const record of this.managedWindows) {
      const win = record.win;
      if (this.isWindowDestroyed(win)) {
        continue;
      }

      this.applyLayer0(win, true);
      this.applyNativeStealth(win);
    }
  }

  private ensureCGWindowMonitor(): void {
    if (
      this.cgWindowMonitorHandle ||
      !this.isEnabled() ||
      !this.isEnhancedStealthEnabled() ||
      this.platform !== 'darwin'
    ) {
      return;
    }

    this.cgWindowMonitorHandle = this.intervalScheduler(
      () => this.pollCGWindowVisibility(),
      CGWINDOW_VISIBILITY_CHECK_MS
    );
    this.logger.log('[StealthManager] CGWindow visibility monitor started');
  }

  private async pollCGWindowVisibility(): Promise<void> {
    if (this.cgWindowMonitorRunning) {
      return;
    }

    this.cgWindowMonitorRunning = true;
    try {
      const visibleWindowNumbers = await this.getWindowNumbersVisibleToCapture();
      let windowVisibleToCaptureDetected = false;

      for (const record of this.managedWindows) {
        const win = record.win;
        if (this.isWindowDestroyed(win)) {
          continue;
        }

        const windowNumber = this.getMacosWindowNumber(win);
        if (windowNumber === null) {
          continue;
        }

        if (visibleWindowNumbers.has(windowNumber)) {
          windowVisibleToCaptureDetected = true;
          this.logger.log(`[StealthManager] Window ${windowNumber} is visible to capture tools - applying emergency protection`);
          this.applyEmergencyProtection(win);
        }
      }

      if (windowVisibleToCaptureDetected) {
        this.captureVisibleToToolsActive = true;
        this.addWarning('window_visible_to_capture');
      } else if (this.captureVisibleToToolsActive) {
        this.captureVisibleToToolsActive = false;
        this.clearWarning('window_visible_to_capture');
      }
    } catch (error) {
      this.logger.warn('[StealthManager] CGWindow visibility check failed, maintaining Layer 0 protection:', error);
    } finally {
      this.cgWindowMonitorRunning = false;
    }
  }

  private async getWindowNumbersVisibleToCapture(): Promise<Set<number>> {
    const visibleWindows = new Set<number>();

    try {
      const stdout = await this.processEnumerator('python3', ['-c', `
import Quartz
import sys

windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionAll,
    Quartz.kCGNullWindowID
)

for window in windows:
    window_number = window.get('kCGWindowNumber', -1)
    layer = window.get('kCGWindowLayer', -1)
    alpha = window.get('kCGWindowAlpha', 1.0)
    sharing_state = window.get('kCGWindowSharingState', 0)

    if window_number > 0 and alpha > 0 and layer == 0 and sharing_state > 0:
        print(window_number)
`]);

      if (stdout && stdout.trim()) {
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const windowNumber = parseInt(line, 10);
          if (Number.isFinite(windowNumber) && windowNumber > 0) {
            visibleWindows.add(windowNumber);
          }
        }
      }
    } catch {
      // Ignore
    }

    return visibleWindows;
  }

  private applyEmergencyProtection(win: StealthCapableWindow): void {
    if (this.isWindowDestroyed(win)) {
      return;
    }

    if (typeof win.setOpacity === 'function') {
      win.setOpacity(0);
    }

    if (typeof win.hide === 'function') {
      win.hide();
    }

    this.applyLayer0(win, true);
    this.applyNativeStealth(win);

    if (!this.stealthEnhancer) {
      this.stealthEnhancer = new MacosStealthEnhancer({
        platform: this.platform,
        logger: this.logger,
      });
    }

    const windowNumber = this.getMacosWindowNumber(win);
    if (windowNumber !== null) {
      void this.stealthEnhancer.enhanceWindowProtection(windowNumber);
    }
  }

  private ensureTCCMonitor(): void {
    if (
      !this.isEnabled() ||
      !this.isEnhancedStealthEnabled() ||
      this.platform !== 'darwin'
    ) {
      return;
    }

    if (!this.tccMonitor) {
      this.tccMonitor = new TCCMonitor({
        platform: this.platform,
        checkIntervalMs: 2000,
        logger: this.logger,
      });

      this.tccMonitor.on('tool-detected', (info) => {
        this.logger.log(`[StealthManager] Enterprise tool detected: ${info.name} (${info.category})`);
        this.addWarning(`enterprise_tool_${info.name.toLowerCase()}`);
        if (info.category === 'proctoring' || info.category === 'monitoring') {
          this.applyChromiumCountermeasures();
        }
      });

      this.tccMonitor.on('permission-granted', (info) => {
        this.logger.log(`[StealthManager] New ScreenCapture permission granted: ${info.bundleId}`);
        this.addWarning('new_screencapture_permission');
      });

      this.tccMonitor.start();
    }
  }

  private ensureOpacityFlicker(): void {
    if (
      this.opacityFlickerHandle ||
      !this.isEnabled() ||
      !this.isEnhancedStealthEnabled() ||
      this.platform !== 'darwin' ||
      !this.isMacOS15Plus
    ) {
      return;
    }

    // NAT-010 / audit S-1: the periodic 500 ms cadence is itself a
    // detectable timing fingerprint, so it stays *off* by default. The
    // method is preserved (and `applyOpacityFlicker()` remains callable)
    // so that capture-bypass test fixtures (NAT-082) can opt in via
    // `featureFlags.enableOpacityFlicker = true` and so a future
    // `bus:capture-start-detected` event can fire it as a one-shot.
    if (!this.featureFlags.enableOpacityFlicker) {
      return;
    }

    this.opacityFlickerHandle = this.intervalScheduler(
      () => this.applyOpacityFlicker(),
      500
    );
    Metrics.gauge('stealth.flicker_active', 1);
    this.logger.log('[StealthManager] macOS 15.4+ opacity flicker enabled (500ms interval)');
  }

  private applyOpacityFlicker(): void {
    for (const record of this.managedWindows) {
      const win = record.win;
      if (this.isWindowDestroyed(win)) {
        continue;
      }

      if (typeof win.setOpacity === 'function') {
        try {
          win.setOpacity(0.999);
          this.timeoutScheduler(() => {
            if (!this.isWindowDestroyed(win) && typeof win.setOpacity === 'function') {
              win.setOpacity(1);
            }
          }, 30);
        } catch (error) {
          this.logger.warn('[StealthManager] Opacity flicker failed, continuing with Layer 0+1:', error);
        }
      }
    }
  }

  private hideAndRestoreVisibleWindows(): void {
    const windowsToRestore: Array<{ win: StealthCapableWindow; restoreWithOpacity: boolean }> = [];

    for (const record of this.managedWindows) {
      const win = record.win;
      if (this.isWindowDestroyed(win)) {
        continue;
      }

      const wasVisible = typeof win.isVisible === 'function' ? win.isVisible() : true;
      if (!wasVisible) {
        continue;
      }

      if (typeof win.setOpacity === 'function') {
        win.setOpacity(0);
        this.reapplyAfterShow(win);
        windowsToRestore.push({ win, restoreWithOpacity: true });
      } else if (typeof win.hide === 'function' && typeof win.show === 'function') {
        win.hide();
        windowsToRestore.push({ win, restoreWithOpacity: false });
      }
    }

    if (windowsToRestore.length === 0) {
      return;
    }

    const attemptRestore = async (): Promise<void> => {
      await this.delay(WATCHDOG_RESTORE_DELAY_MS);

      const stillRunning = await this.detectCaptureProcesses();
      if (stillRunning.length > 0) {
        this.logger.log('[StealthManager] Capture tools still running, delaying window restore');
        await this.delay(WATCHDOG_RESTORE_DELAY_MS * 2);

        const recheck = await this.detectCaptureProcesses();
        if (recheck.length > 0) {
          this.logger.warn('[StealthManager] Capture tools persist, keeping windows hidden');
          this.addWarning('capture_tools_still_running');
          return;
        }
      }

      this.clearWarning('capture_tools_still_running');

      for (const { win, restoreWithOpacity } of windowsToRestore) {
        if (this.isWindowDestroyed(win)) {
          continue;
        }

        if (restoreWithOpacity && typeof win.setOpacity === 'function') {
          win.setOpacity(1);
        } else if (typeof win.show === 'function') {
          win.show();
        }
        this.reapplyAfterShow(win);
      }
    };

    void attemptRestore();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timeoutScheduler(() => resolve(), ms);
    });
  }

  verifyStealth(win: StealthCapableWindow): boolean {
    const nativeModule = this.getNativeModule();
    const record = this.managedWindowLookup.get(win as object);
    if (!nativeModule) {
      return this.isEnabled();
    }

    try {
      if (this.platform === 'darwin' && nativeModule.verifyMacosStealthState) {
        const windowNumber = this.getMacosWindowNumber(win);
        if (windowNumber === null) {
          return false;
        }

        const sharingType = nativeModule.verifyMacosStealthState(windowNumber);
        // The private CGS path does not reliably reflect through NSWindow.sharingType.
        const privatePathVerified = Boolean(
          this.featureFlags.enablePrivateMacosStealthApi &&
          this.isMacOSVersionCompatible('15.0') &&
          record?.privateMacosStealthApplied
        );
        const verified = sharingType === 0 || privatePathVerified;
        if (!verified && this.isEnabled()) {
          this.addWarning('stealth_verification_failed');
          this.logger.warn('[StealthManager] macOS stealth verification failed, maintaining Layer 0 protection');
        } else {
          this.clearWarning('stealth_verification_failed');
        }
        return verified;
      }

      if (this.platform === 'win32' && nativeModule.verifyWindowsStealthState) {
        const handle = win.getNativeWindowHandle?.();
        if (!handle) {
          return false;
        }

        const affinity = nativeModule.verifyWindowsStealthState(handle);
        const verified = affinity === 0x11 || affinity === 0x01;
        if (!verified && this.isEnabled()) {
          this.addWarning('stealth_verification_failed');
          this.logger.warn('[StealthManager] Windows stealth verification failed, maintaining Layer 0 protection');
        } else {
          this.clearWarning('stealth_verification_failed');
        }
        return verified;
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Stealth verification failed, falling back to Layer 0:', error);
    }

    return false;
  }

  private getNativeModule(): NativeStealthBindings | null {
    if (this.nativeModule !== undefined) {
      if (this.nativeModule === null && this.isEnabled()) {
        this.addWarning('native_module_unavailable');
      } else if (this.nativeModule !== null) {
        this.clearWarning('native_module_unavailable');
      }
      return this.nativeModule;
    }

    this.nativeModule = loadNativeStealthModule({ retryOnFailure: true });
    if (this.nativeModule === null && this.isEnabled()) {
      this.addWarning('native_module_unavailable');
      this.logger.warn('[StealthManager] Native module unavailable, operating in Layer 0 mode only');
    } else if (this.nativeModule !== null) {
      this.clearWarning('native_module_unavailable');
    }
    return this.nativeModule;
  }

  private resolvePowerMonitor(): { on: (event: string, listener: () => void) => void } | null {
    try {
      const electronModule = require('electron');
      return electronModule?.powerMonitor ?? null;
    } catch {
      return null;
    }
  }

  private defaultHideFromSwitcher(role: StealthWindowRole): boolean {
    return role === 'auxiliary';
  }

  private isWindowDestroyed(win: StealthCapableWindow): boolean {
    return typeof win.isDestroyed === 'function' ? win.isDestroyed() : false;
  }
}
