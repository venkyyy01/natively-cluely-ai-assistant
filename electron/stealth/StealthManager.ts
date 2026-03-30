import { isOptimizationActive } from '../config/optimizations';
import { EventEmitter } from 'events';
import type { VirtualDisplayCoordinator } from './MacosVirtualDisplayClient';

import { loadNativeStealthModule } from './nativeStealthModule';
import { execFile } from 'node:child_process';

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
}

const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_RESTORE_DELAY_MS = 500;
const DISPLAY_MOVE_RETRY_DELAY_MS = 100;
const DISPLAY_MOVE_MAX_RETRIES = 10;
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
];

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
  private watchdogRunning = false;

  constructor(config: StealthConfig, deps: StealthManagerDependencies = {}) {
    super();
    this.config = config;
    this.platform = deps.platform ?? process.platform;
    this.logger = deps.logger ?? console;
    this.powerMonitor = deps.powerMonitor ?? this.resolvePowerMonitor();
    this.screenApi = deps.screenApi ?? this.resolveScreenApi();
    this.displayEvents = deps.displayEvents ?? this.resolveDisplayEvents(this.screenApi);
    this.featureFlags = deps.featureFlags ?? {};
    this.intervalScheduler = deps.intervalScheduler ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.clearIntervalScheduler = deps.clearIntervalScheduler ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.timeoutScheduler = deps.timeoutScheduler ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.virtualDisplayCoordinator = deps.virtualDisplayCoordinator ?? null;
    this.captureToolPatterns = deps.captureToolPatterns ?? KNOWN_CAPTURE_TOOL_PATTERNS;
    this.processEnumerator = deps.processEnumerator ?? defaultProcessEnumerator;
    this.nativeModule = deps.nativeModule;
  }

  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled };
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
  }

  reapplyAfterShow(win: StealthCapableWindow): void {
    if (!win || this.isWindowDestroyed(win) || !this.isEnabled()) {
      return;
    }

    const record = this.managedWindowLookup.get(win as object);
    if (!record) {
      return;
    }

    this.applyToWindow(win, true, {
      role: record.role,
      hideFromSwitcher: record.hideFromSwitcher,
      allowVirtualDisplayIsolation: record.allowVirtualDisplayIsolation,
    });
  }

  private isEnabled(): boolean {
    return this.config.enabled;
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
            nativeModule.applyMacosPrivateWindowStealth(windowNumber);
          }
          this.verifyStealth(win);
        }
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Native stealth application failed:', error);
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
    const mediaSourceId = win.getMediaSourceId?.();
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
    const windowId = win.getMediaSourceId?.();
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
      this.logger.warn('[StealthManager] Virtual display isolation failed:', error);
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

    const windowId = win.getMediaSourceId?.();
    if (!windowId) {
      return;
    }

    this.virtualDisplayCoordinator.releaseIsolationForWindow({ windowId }).catch((error) => {
      this.logger.warn('[StealthManager] Virtual display isolation release failed:', error);
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
    });
    record.listenersAttached = true;
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
  }

  private async pollCaptureTools(): Promise<void> {
    if (this.watchdogRunning) {
      return;
    }

    this.watchdogRunning = true;
    try {
      const suspiciousToolMatches = await this.detectCaptureProcesses();

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
      const matches: RegExp[] = [];
      for (const pattern of this.captureToolPatterns) {
        const stdout = await this.processEnumerator('pgrep', ['-lif', pattern.source]);
        if (pattern.test(stdout)) {
          matches.push(pattern);
        }
      }
      return matches;
    }

    return [];
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
        }
        return verified;
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Stealth verification failed:', error);
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

    this.nativeModule = loadNativeStealthModule();
    if (this.nativeModule === null && this.isEnabled()) {
      this.addWarning('native_module_unavailable');
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
