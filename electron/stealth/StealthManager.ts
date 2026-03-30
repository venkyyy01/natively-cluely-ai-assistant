import { isOptimizationActive } from '../config/optimizations';

import { loadNativeStealthModule } from './nativeStealthModule';

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
  removeMacosWindowStealth?: (windowNumber: number) => void;
  applyWindowsWindowStealth?: (handle: Buffer) => void;
  removeWindowsWindowStealth?: (handle: Buffer) => void;
}

export type StealthWindowRole = 'primary' | 'auxiliary';

export interface StealthApplyOptions {
  role?: StealthWindowRole;
  hideFromSwitcher?: boolean;
}

interface StealthManagerDependencies {
  nativeModule?: NativeStealthBindings | null;
  platform?: string;
  powerMonitor?: { on: (event: string, listener: () => void) => void } | null;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

interface StealthCapableWindow {
  on?: (event: string, listener: () => void) => void;
  setContentProtection: (value: boolean) => void;
  setHiddenInMissionControl?: (value: boolean) => void;
  setExcludedFromShownWindowsMenu?: (value: boolean) => void;
  setSkipTaskbar?: (value: boolean) => void;
  getNativeWindowHandle?: () => Buffer;
  getMediaSourceId?: () => string;
  isDestroyed?: () => boolean;
}

interface ManagedWindowRecord {
  win: StealthCapableWindow;
  role: StealthWindowRole;
  hideFromSwitcher: boolean;
  listenersAttached: boolean;
}

export class StealthManager {
  private config: StealthConfig;
  private readonly platform: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly powerMonitor: { on: (event: string, listener: () => void) => void } | null;
  private readonly managedWindows = new Set<ManagedWindowRecord>();
  private readonly managedWindowLookup = new WeakMap<object, ManagedWindowRecord>();
  private nativeModule: NativeStealthBindings | null | undefined;
  private powerMonitorBound = false;

  constructor(config: StealthConfig, deps: StealthManagerDependencies = {}) {
    this.config = config;
    this.platform = deps.platform ?? process.platform;
    this.logger = deps.logger ?? console;
    this.powerMonitor = deps.powerMonitor ?? this.resolvePowerMonitor();
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

    this.applyLayer0(win, true);
    this.applyUiHardening(win, record.hideFromSwitcher);
    this.applyNativeStealth(win);
    this.attachLifecycleListeners(record);
    this.bindPowerMonitor();
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
    });
  }

  private isEnabled(): boolean {
    return this.config.enabled && isOptimizationActive('useStealthMode');
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
        }
        return;
      }

      if (this.platform === 'darwin' && nativeModule.applyMacosWindowStealth) {
        const windowNumber = this.getMacosWindowNumber(win);
        if (windowNumber !== null) {
          nativeModule.applyMacosWindowStealth(windowNumber);
        }
      }
    } catch (error) {
      this.logger.warn('[StealthManager] Native stealth application failed:', error);
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

  private getOrCreateRecord(win: StealthCapableWindow, options: StealthApplyOptions): ManagedWindowRecord {
    const existing = this.managedWindowLookup.get(win as object);
    if (existing) {
      return existing;
    }

    const record: ManagedWindowRecord = {
      win,
      role: options.role ?? 'primary',
      hideFromSwitcher: options.hideFromSwitcher ?? this.defaultHideFromSwitcher(options.role ?? 'primary'),
      listenersAttached: false,
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
    this.powerMonitorBound = true;
  }

  private getNativeModule(): NativeStealthBindings | null {
    if (this.nativeModule !== undefined) {
      return this.nativeModule;
    }

    this.nativeModule = loadNativeStealthModule();
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
