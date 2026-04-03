import { isOptimizationActive } from '../config/optimizations';
import { EventEmitter } from 'events';
import type { VirtualDisplayCoordinator } from './MacosVirtualDisplayClient';

import { loadNativeStealthModule } from './nativeStealthModule';
import { execFile } from 'node:child_process';
import { ChromiumCaptureDetector } from './ChromiumCaptureDetector';
import { MacosStealthEnhancer } from './MacosStealthEnhancer';
import { MonitoringDetector } from './MonitoringDetector';
import { ScreenShareDetector } from './ScreenShareDetector';
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
  monitoringDetector?: MonitoringDetector | null;
  screenShareDetector?: ScreenShareDetector | null;
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
  quitApplication?: () => void;
}

interface StealthCapableWindow {
  on?: (event: string, listener: () => void) => void;
  setContentProtection: (value: boolean) => void;
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
  lastWindowsHandleSignature: string | null;
}

const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_RESTORE_DELAY_MS = 500;
const DISPLAY_MOVE_RETRY_DELAY_MS = 100;
const DISPLAY_MOVE_MAX_RETRIES = 10;
const SCSTREAM_CHECK_INTERVAL_MS = 500;
const CGWINDOW_VISIBILITY_CHECK_MS = 500;
const KNOWN_CAPTURE_TOOL_PATTERNS = [
  /obs/i,
  /zoom/i,
  /teams/i,
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
  private readonly quitApplication: () => void;
  private readonly managedWindows = new Set<ManagedWindowRecord>();
  private readonly managedWindowLookup = new WeakMap<object, ManagedWindowRecord>();
  private nativeModule: NativeStealthBindings | null | undefined;
  private monitoringDetector: MonitoringDetector | null;
  private screenShareDetector: ScreenShareDetector | null;
  private powerMonitorBound = false;
  private displayEventsBound = false;
  private watchdogHandle: unknown = null;
  private windowsAffinityHandle: unknown = null;
  private monitoringHandle: unknown = null;
  private watchdogRunning = false;
  private monitoringRunning = false;
  private scStreamMonitorHandle: unknown = null;
  private scStreamMonitorRunning = false;
  private scStreamActive = false;
  private captureSuppressionActive = false;
  private chromiumDetector: ChromiumCaptureDetector | null = null;
  private stealthEnhancer: MacosStealthEnhancer | null = null;
  private cgWindowMonitorHandle: unknown = null;
  private cgWindowMonitorRunning = false;
  private tccMonitor: TCCMonitor | null = null;
  private isMacOS15Plus = false;
  private macOSMajor: number = 0;
  private macOSMinor: number = 0;
  private opacityFlickerHandle: unknown = null;
  private powerReapplyGeneration = 0;
  private displayReapplyGeneration = 0;

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
    this.quitApplication = deps.quitApplication ?? this.resolveQuitApplication();
    this.nativeModule = deps.nativeModule;
    this.monitoringDetector = deps.monitoringDetector ?? null;
    this.screenShareDetector = deps.screenShareDetector ?? null;
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
      skipTaskbar: this.platform === 'win32' ? enabled : false,
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
      this.applyLayer0(win, false);
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
    this.ensureWindowsMonitoring();
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

  private isEnabled(): boolean {
    return this.config.enabled;
  }

  private isEnhancedStealthEnabled(): boolean {
    if (this.platform === 'win32' && this.isEnabled()) {
      return true;
    }

    return isOptimizationActive('useStealthMode');
  }

  private applyLayer0(win: StealthCapableWindow, enable: boolean): void {
    try {
      win.setContentProtection(enable);
    } catch (error) {
      this.logger.warn('[StealthManager] setContentProtection failed:', error);
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
    if (!nativeModule) {
      return;
    }

    try {
      if (this.platform === 'win32' && nativeModule.applyWindowsWindowStealth) {
        const handle = win.getNativeWindowHandle?.();
        if (handle) {
          const record = this.managedWindowLookup.get(win as object);
          if (record) {
            record.lastWindowsHandleSignature = handle.toString('hex');
          }
          nativeModule.applyWindowsWindowStealth(handle);
          this.verifyStealth(win);
        }
        return;
      }

      if (this.platform === 'darwin' && nativeModule.applyMacosWindowStealth) {
        const windowNumber = this.getMacosWindowNumber(win);
        if (windowNumber !== null) {
          nativeModule.applyMacosWindowStealth(windowNumber);
          
          if (this.featureFlags.enablePrivateMacosStealthApi && nativeModule.applyMacosPrivateWindowStealth) {
            if (this.isMacOSVersionCompatible('15.0')) {
              try {
                nativeModule.applyMacosPrivateWindowStealth(windowNumber);
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

    const win = record.win;
    const windowId = this.safeGetMediaSourceId(win);
    if (!windowId) {
      return;
    }

    const requestId = record.virtualDisplayRequestId + 1;
    record.virtualDisplayRequestId = requestId;
    record.virtualDisplayIsolationStarted = true;

    this.virtualDisplayCoordinator.ensureIsolationForWindow({
      sessionId: windowId,
      windowId,
      width: win.getBounds?.().width ?? 0,
      height: win.getBounds?.().height ?? 0,
    }).then((response) => {
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
    }).catch((error) => {
      if (this.isCurrentVirtualDisplayRequest(record, requestId)) {
        record.virtualDisplayIsolationStarted = false;
      }
      this.logger.warn('[StealthManager] Virtual display isolation failed, falling back to Layer 0+1:', error);
      if (this.isEnabled()) {
        if (this.virtualDisplayCoordinator.isExhausted?.()) {
          this.addWarning('virtual_display_exhausted');
        } else {
          this.addWarning('virtual_display_failed');
        }
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
      lastWindowsHandleSignature: null,
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
    record.win.on('focus', reapply);
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

  private getWindowsHandleSignature(win: StealthCapableWindow): string | null {
    try {
      const handle = win.getNativeWindowHandle?.();
      if (!handle || handle.length === 0) {
        return null;
      }

      return handle.toString('hex');
    } catch {
      return null;
    }
  }

  private scheduleReapplyAll(kind: 'power' | 'display', delayMs: number): void {
    const generation = kind === 'power'
      ? ++this.powerReapplyGeneration
      : ++this.displayReapplyGeneration;

    if (delayMs <= 0) {
      if (!this.isEnabled()) {
        return;
      }

      for (const record of this.managedWindows) {
        this.reapplyAfterShow(record.win);
      }
      return;
    }

    this.timeoutScheduler(() => {
      const currentGeneration = kind === 'power' ? this.powerReapplyGeneration : this.displayReapplyGeneration;
      if (generation !== currentGeneration || !this.isEnabled()) {
        return;
      }

      for (const record of this.managedWindows) {
        this.reapplyAfterShow(record.win);
      }
    }, delayMs);
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

    if (this.monitoringHandle) {
      this.clearIntervalScheduler(this.monitoringHandle);
      this.monitoringHandle = null;
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
    }

    this.watchdogRunning = false;
    this.monitoringRunning = false;
    this.scStreamMonitorRunning = false;
    this.cgWindowMonitorRunning = false;
    this.scStreamActive = false;

    if (this.captureSuppressionActive) {
      this.captureSuppressionActive = false;
      this.clearWarning('screen_share_detected');
      this.emit('screen-share-cleared', { platform: this.platform, reason: 'monitors-stopped' });
    }

    this.clearWarning('windows_screen_share_detected');

    if (this.chromiumDetector) {
      this.chromiumDetector.stop();
      this.chromiumDetector = null;
    }

    if (this.tccMonitor) {
      this.tccMonitor.stop();
      this.tccMonitor = null;
    }
  }

  private bindPowerMonitor(): void {
    if (this.powerMonitorBound || !this.powerMonitor) {
      return;
    }

    const reapplyAll = () => this.scheduleReapplyAll('power', this.platform === 'win32' ? 250 : 0);

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

    const reapplyAll = () => this.scheduleReapplyAll('display', this.platform === 'win32' ? 250 : 0);

    this.displayEvents.on('display-metrics-changed', reapplyAll);
    if (this.platform === 'darwin' || this.platform === 'win32') {
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
      this.windowsAffinityHandle = this.intervalScheduler(() => this.verifyWindowsAffinity(), 250);
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

      const handleSignature = this.getWindowsHandleSignature(win);
      if (handleSignature && handleSignature !== record.lastWindowsHandleSignature) {
        record.lastWindowsHandleSignature = handleSignature;
        this.logger.log('[StealthManager] Windows native handle changed - reapplying stealth immediately');
        this.applyNativeStealth(win);
        continue;
      }

      try {
        const affinity = nativeModule.verifyWindowsStealthState(handle);
        if (affinity !== 0x11) {
          this.logger.log('[StealthManager] Windows display affinity was reset - reapplying');
          this.applyNativeStealth(win);
        }
      } catch {
        // Ignore verification errors
      }
    }
  }

  private async pollCaptureTools(): Promise<void> {
    if (this.watchdogRunning) {
      return;
    }

    this.watchdogRunning = true;
    try {
      const suspiciousToolMatches = await this.detectCaptureProcesses();
      let windowsScreenShareActive = false;

      if (this.platform === 'win32') {
        const status = await this.getScreenShareDetector().detect();
        windowsScreenShareActive = status.active;
        if (windowsScreenShareActive) {
          this.addWarning('windows_screen_share_detected');
        } else {
          this.clearWarning('windows_screen_share_detected');
        }
      }

      const captureDetected = suspiciousToolMatches.length > 0 || windowsScreenShareActive;
      if (captureDetected) {
        if (!this.captureSuppressionActive) {
          this.captureSuppressionActive = true;
          this.emit('screen-share-detected', {
            platform: this.platform,
            suspiciousToolPatterns: suspiciousToolMatches.map((pattern) => pattern.source),
            windowsScreenShareActive,
          });
        }
        this.logger.log(
          `[StealthManager] Capture watchdog detected suspicious tools running. Patterns triggered: ${suspiciousToolMatches.length}${windowsScreenShareActive ? ' + windows screen-share heuristic' : ''}`
        );
        this.addWarning('screen_share_detected');
        this.hideAndRestoreVisibleWindows();
        return;
      }

      if (this.captureSuppressionActive) {
        this.captureSuppressionActive = false;
        this.clearWarning('screen_share_detected');
        this.emit('screen-share-cleared', { platform: this.platform });
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

      const stdout3 = await this.processEnumerator('pgrep', ['-lf', 'WindowServer']);
      if (stdout3 && stdout3.trim()) {
        return false;
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
          this.logger.log(`[StealthManager] Window ${windowNumber} is visible to capture tools - applying emergency protection`);
          this.applyEmergencyProtection(win);
          if (!this.scStreamActive) {
            this.scStreamActive = true;
            this.addWarning('window_visible_to_capture');
          }
        }
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
      this.timeoutScheduler(() => {
        if (!this.isWindowDestroyed(win) && typeof win.setOpacity === 'function') {
          win.setOpacity(1);
          this.applyLayer0(win, true);
          this.applyNativeStealth(win);
        }
      }, 100);
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

  private ensureWindowsMonitoring(): void {
    if (
      this.platform !== 'win32' ||
      this.monitoringHandle ||
      !this.isEnabled() ||
      !this.isEnhancedStealthEnabled() ||
      !this.featureFlags.enableCaptureDetectionWatchdog
    ) {
      return;
    }

    this.monitoringHandle = this.intervalScheduler(() => this.pollMonitoringThreats(), 15000);
  }

  private async pollMonitoringThreats(): Promise<void> {
    if (this.monitoringRunning) {
      return;
    }

    this.monitoringRunning = true;
    try {
      const result = await this.getMonitoringDetector().detectAll();
      if (!result.detected) {
        this.clearWarning('windows_monitoring_software_detected');
        return;
      }

      this.addWarning('windows_monitoring_software_detected');
      this.logger.warn(
        `[StealthManager] Monitoring software detected on Windows via ${result.detectionMethod}: ${result.threats
          .map((threat) => `${threat.name}:${threat.vector}`)
          .join(', ')}`
      );
      const shouldQuit = result.threats.some((threat) => threat.vector === 'process' || threat.vector === 'window' || threat.vector === 'launch-agent');
      if (shouldQuit) {
        this.quitApplication();
      } else {
        this.logger.warn('[StealthManager] Windows monitoring detection did not reach a blocking runtime signal; keeping app running with degraded warning');
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Monitoring detection failed:', error);
    } finally {
      this.monitoringRunning = false;
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

    this.opacityFlickerHandle = this.intervalScheduler(
      () => this.applyOpacityFlicker(),
      100
    );
    this.logger.log('[StealthManager] macOS 15.4+ opacity flicker enabled (100ms interval)');
  }

  private applyOpacityFlicker(): void {
    for (const record of this.managedWindows) {
      const win = record.win;
      if (this.isWindowDestroyed(win)) {
        continue;
      }

      if (typeof win.setOpacity === 'function') {
        try {
          win.setOpacity(0.99);
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

    this.timeoutScheduler(() => {
      for (const { win, restoreWithOpacity } of windowsToRestore) {
        if (this.isWindowDestroyed(win)) {
          continue;
        }

        if (restoreWithOpacity && typeof win.setOpacity === 'function') {
          win.setOpacity(1);
        } else {
          win.show?.();
        }
        this.reapplyAfterShow(win);
      }
    }, WATCHDOG_RESTORE_DELAY_MS);
  }

  verifyStealth(win: StealthCapableWindow): boolean {
    const nativeModule = this.getNativeModule();
    if (!nativeModule) {
      return false;
    }

    try {
      if (this.platform === 'darwin' && nativeModule.verifyMacosStealthState) {
        const windowNumber = this.getMacosWindowNumber(win);
        if (windowNumber === null) {
          return false;
        }

        const sharingType = nativeModule.verifyMacosStealthState(windowNumber);
        const verified = sharingType === 0;
        if (!verified && this.isEnabled()) {
          this.addWarning('stealth_verification_failed');
          this.logger.warn('[StealthManager] macOS stealth verification failed, maintaining Layer 0 protection');
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
        }
        return verified;
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Stealth verification failed, falling back to Layer 0:', error);
    }

    return false;
  }

  private getNativeModule(): NativeStealthBindings | null {
    if (this.nativeModule !== undefined && this.nativeModule !== null) {
      this.clearWarning('native_module_unavailable');
      return this.nativeModule;
    }

    const previousModule = this.nativeModule;
    this.nativeModule = loadNativeStealthModule({ retryOnFailure: true });
    if (this.nativeModule === null && this.isEnabled()) {
      this.addWarning('native_module_unavailable');
      this.logger.warn('[StealthManager] Native module unavailable, operating in Layer 0 mode only');
    } else if (this.nativeModule !== null) {
      this.clearWarning('native_module_unavailable');
      if (previousModule === null && this.isEnabled()) {
        for (const record of this.managedWindows) {
          this.reapplyAfterShow(record.win);
        }
      }
    }
    return this.nativeModule;
  }

  private getMonitoringDetector(): MonitoringDetector {
    if (!this.monitoringDetector) {
      this.monitoringDetector = new MonitoringDetector({
        platform: this.platform,
        logger: this.logger,
      });
    }

    return this.monitoringDetector;
  }

  private getScreenShareDetector(): ScreenShareDetector {
    if (!this.screenShareDetector) {
      this.screenShareDetector = new ScreenShareDetector({
        platform: this.platform,
        logger: this.logger,
      });
    }

    return this.screenShareDetector;
  }

  private resolvePowerMonitor(): { on: (event: string, listener: () => void) => void } | null {
    try {
      const electronModule = require('electron');
      return electronModule?.powerMonitor ?? null;
    } catch {
      return null;
    }
  }

  private resolveQuitApplication(): () => void {
    return () => {
      try {
        const electronModule = require('electron');
        electronModule?.app?.quit?.();
      } catch (error) {
        this.logger.warn('[StealthManager] Failed to resolve app.quit for emergency shutdown:', error);
      }
    };
  }

  private defaultHideFromSwitcher(role: StealthWindowRole): boolean {
    return role === 'auxiliary' || (this.platform === 'win32' && this.isEnabled());
  }

  private isWindowDestroyed(win: StealthCapableWindow): boolean {
    return typeof win.isDestroyed === 'function' ? win.isDestroyed() : false;
  }
}
