import { BrowserWindow, app, ipcMain, type IpcMainEvent } from 'electron';
import path from 'node:path';

import { FrameBridge } from './frameBridge';
import { InputBridge } from './inputBridge';
import type { StealthInputEvent } from './types';
import type { StealthManager } from './StealthManager';
import { attachRendererBridgeMonitor } from '../runtime/rendererBridgeHealth';
import {
  resolveRendererPreloadPath,
  resolveStealthShellHtmlPath,
  resolveStealthShellPreloadPath,
} from '../runtime/windowAssetPaths';

type RuntimeWindow = Pick<BrowserWindow,
  | 'loadURL'
  | 'loadFile'
  | 'show'
  | 'hide'
  | 'close'
  | 'focus'
  | 'setBounds'
  | 'getBounds'
  | 'setOpacity'
  | 'setAlwaysOnTop'
  | 'isDestroyed'
  | 'on'
  | 'once'
  | 'webContents'
>;

type RuntimeWindowFactory = (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;

interface RuntimeLogger {
  log: Console['log'];
  warn: Console['warn'];
  error: Console['error'];
}

interface StealthRuntimeOptions {
  stealthManager: StealthManager;
  startUrl: string;
  shellHtmlPath?: string;
  createWindow?: RuntimeWindowFactory;
  logger?: RuntimeLogger;
  preloadPath?: string;
  shellPreloadPath?: string;
  ipcMain?: Pick<typeof ipcMain, 'on' | 'removeListener'>;
  onFault: (reason: string) => void | Promise<void>;
  onHeartbeat?: () => void | Promise<void>;
  onFirstFrame?: () => void | Promise<void>;
}

export class StealthRuntime {
  private readonly stealthManager: StealthManager;
  private readonly startUrl: string;
  private readonly shellHtmlPath: string;
  private readonly createWindow: RuntimeWindowFactory;
  private readonly logger: RuntimeLogger;
  private readonly preloadPath: string;
  private readonly shellPreloadPath: string;
  private readonly ipcMain: Pick<typeof ipcMain, 'on' | 'removeListener'>;
  private readonly onFault?: (reason: string) => void | Promise<void>;
  private readonly onHeartbeat?: () => void | Promise<void>;
  private readonly onFirstFrame?: () => void | Promise<void>;
  private readonly frameBridge: FrameBridge;
  private readonly inputBridge = new InputBridge();
  private contentWindow: BrowserWindow | null = null;
  private shellWindow: BrowserWindow | null = null;
  private boundInputHandler: ((event: IpcMainEvent, payload: StealthInputEvent) => void) | null = null;
  private boundReadyHandler: ((event: IpcMainEvent) => void) | null = null;
  private boundHeartbeatHandler: ((event: IpcMainEvent) => void) | null = null;
  private firstFrameReceived = false;
  private showRequestedBeforeFirstFrame = false;
  private firstFrameTimeout: NodeJS.Timeout | null = null;
  private detachContentBridgeMonitor: (() => void) | null = null;

  constructor(options: StealthRuntimeOptions) {
    this.stealthManager = options.stealthManager;
    this.startUrl = options.startUrl;
    this.shellHtmlPath = options.shellHtmlPath ?? resolveStealthShellHtmlPath({ electronDir: path.resolve(__dirname, '..') });
    if (!this.shellHtmlPath.endsWith('.html') || this.shellHtmlPath.includes('..')) {
      throw new Error(`Invalid shellHtmlPath: ${this.shellHtmlPath}`);
    }
    this.createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
    this.logger = options.logger ?? console;
    this.preloadPath = options.preloadPath ?? resolveRendererPreloadPath({ electronDir: path.resolve(__dirname, '..') });
    this.shellPreloadPath = options.shellPreloadPath ?? resolveStealthShellPreloadPath({ electronDir: path.resolve(__dirname, '..') });
    this.ipcMain = options.ipcMain ?? ipcMain;
    this.onFault = options.onFault;
    this.onHeartbeat = options.onHeartbeat;
    this.onFirstFrame = options.onFirstFrame;
    this.frameBridge = new FrameBridge({
      target: {
        send: (channel, payload) => {
          if (channel === 'stealth-shell:frame' && !this.firstFrameReceived) {
            this.firstFrameReceived = true;
            if (this.firstFrameTimeout) {
              clearTimeout(this.firstFrameTimeout);
              this.firstFrameTimeout = null;
            }
            this.logger.log('[StealthRuntime] First frame received by shell');

            if (this.showRequestedBeforeFirstFrame && this.shellWindow && !this.shellWindow.isDestroyed()) {
              this.showRequestedBeforeFirstFrame = false;
              this.shellWindow.show();
              this.shellWindow.focus();
            }

            Promise.resolve(this.onFirstFrame?.()).catch((error) => {
              this.logger.warn('[StealthRuntime] Failed to propagate first-frame event:', error);
            });
          }

          this.shellWindow?.webContents.send(channel, payload);
        },
      },
      logger: this.logger,
    });
  }

  createPrimaryStealthSurface(options: Electron.BrowserWindowConstructorOptions): RuntimeWindow {
    if (this.shellWindow && !this.shellWindow.isDestroyed()) {
      return this.shellWindow;
    }

    const {
      webPreferences,
      show,
      titleBarStyle,
      trafficLightPosition,
      vibrancy,
      visualEffectState,
      transparent,
      hasShadow,
      backgroundColor,
      roundedCorners,
      icon,
      ...contentBaseOptions
    } = options;
    const shellOptions = {
      ...contentBaseOptions,
      titleBarStyle,
      trafficLightPosition,
      vibrancy,
      visualEffectState,
      transparent,
      hasShadow,
      backgroundColor,
      roundedCorners,
      icon,
    };
    let contentWindow: BrowserWindow | null = null;
    try {
      contentWindow = this.createWindow({
        ...contentBaseOptions,
        show: false,
        frame: false,
        transparent: false,
        hasShadow: false,
        backgroundColor: '#000000',
        paintWhenInitiallyHidden: true,
        skipTaskbar: true,
        webPreferences: {
          ...webPreferences,
          preload: this.preloadPath,
          offscreen: true,
          sandbox: false,
          backgroundThrottling: false,
        },
      });
      this.shellWindow = this.createWindow({
        ...shellOptions,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          preload: this.shellPreloadPath,
          backgroundThrottling: false,
        },
      });
    } catch (error) {
      contentWindow?.close();
      this.shellWindow?.close();
      throw error;
    }

    this.contentWindow = contentWindow;
    this.firstFrameReceived = false;
    this.showRequestedBeforeFirstFrame = false;
    this.detachContentBridgeMonitor?.();
    this.detachContentBridgeMonitor = attachRendererBridgeMonitor('Stealth content', this.contentWindow, {
      expectedPreloadPath: this.preloadPath,
      url: this.startUrl,
      logger: this.logger,
      onSettled: (result) => {
        if (result === 'failed') {
          this.emitFault('content-preload-bridge-unavailable');
        }
      },
    });
    this.frameBridge.attach(this.contentWindow.webContents as unknown as Parameters<FrameBridge['attach']>[0]);
    this.bindShellEvents();

    // NAT-025: apply content protection before any load on both shell and content windows
    for (const win of [this.contentWindow, this.shellWindow]) {
      if (win && typeof (win as any).setContentProtection === 'function') {
        try {
          (win as any).setContentProtection(true);
        } catch (err) {
          this.logger.warn('[StealthRuntime] setContentProtection failed:', err);
        }
      }
      if (win && typeof (win as any).setExcludeFromCapture === 'function') {
        try {
          (win as any).setExcludeFromCapture(true);
        } catch (err) {
          this.logger.warn('[StealthRuntime] setExcludeFromCapture failed:', err);
        }
      }
    }

    // Always use loadURL so packaged file:// targets keep their query string.
    void this.contentWindow.loadURL(this.startUrl).catch((err) => {
      this.logger.warn('[StealthRuntime] Content window loadURL failed:', err);
    });

    void this.shellWindow.loadFile(this.shellHtmlPath).catch((err) => {
      this.logger.warn('[StealthRuntime] Shell window loadFile failed:', err);
    });

    this.shellWindow.webContents.on('did-finish-load', () => {
      this.logger.log('[StealthRuntime] Shell window did-finish-load');
    });

    this.shellWindow.webContents.on('did-fail-load', (_event, code, desc) => {
      this.logger.warn(`[StealthRuntime] Shell window did-fail-load: ${code} ${desc}`);
    });

    this.contentWindow.webContents.on('did-finish-load', () => {
      this.logger.log('[StealthRuntime] Content window did-finish-load');
      this.requestInitialFrame('content-did-finish-load');
    });

    this.contentWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
      this.logger.warn(`[StealthRuntime] Content window did-fail-load: ${code} ${desc} URL: ${url}`);
    });

    this.contentWindow.webContents.on('crashed', (_event, killed) => {
      this.logger.warn(`[StealthRuntime] Content window crashed (killed=${killed})`);
      this.handleContentCrash('content-window-crashed');
    });

    this.contentWindow.webContents.on('render-process-gone', (_event, details) => {
      this.logger.warn(`[StealthRuntime] Content render process gone: ${details.reason} exitCode=${details.exitCode}`);
      this.handleContentCrash(`content-render-gone:${details.reason}`);
    });

    this.firstFrameTimeout = setTimeout(() => {
      if (!this.firstFrameReceived) {
        this.logger.warn('[StealthRuntime] No frames received after 10s - content window may have failed to load');
        this.emitFault('content-first-frame-timeout');
      }
    }, 10000);
    this.firstFrameTimeout.unref?.();

    this.shellWindow.on('resize', () => this.syncBounds());
    this.shellWindow.on('move', () => this.syncBounds());
    this.shellWindow.on('closed', () => this.destroy());
    this.contentWindow.on('closed', () => {
      this.contentWindow = null;
    });

    return this.shellWindow;
  }

  getShellWindow(): BrowserWindow | null {
    return this.shellWindow;
  }

  getContentWindow(): BrowserWindow | null {
    return this.contentWindow;
  }

  hasReceivedFirstFrame(): boolean {
    return this.firstFrameReceived;
  }

  show(): void {
    if (!this.shellWindow || this.shellWindow.isDestroyed()) {
      return;
    }
    if (!this.firstFrameReceived) {
      this.showRequestedBeforeFirstFrame = true;
      return;
    }
    this.shellWindow.show();
    this.shellWindow.focus();
  }

  hide(): void {
    this.shellWindow?.hide();
  }

  destroy(): void {
    this.frameBridge.detach();
    if (this.firstFrameTimeout) {
      clearTimeout(this.firstFrameTimeout);
      this.firstFrameTimeout = null;
    }
    this.detachContentBridgeMonitor?.();
    this.detachContentBridgeMonitor = null;
    if (this.boundInputHandler) {
      this.ipcMain.removeListener('stealth-shell:input', this.boundInputHandler);
      this.boundInputHandler = null;
    }
    if (this.boundReadyHandler) {
      this.ipcMain.removeListener('stealth-shell:ready', this.boundReadyHandler);
      this.boundReadyHandler = null;
    }
    if (this.boundHeartbeatHandler) {
      this.ipcMain.removeListener('stealth-shell:heartbeat', this.boundHeartbeatHandler);
      this.boundHeartbeatHandler = null;
    }
    if (this.contentWindow && !this.contentWindow.isDestroyed()) {
      this.contentWindow.close();
    }
    if (this.shellWindow && !this.shellWindow.isDestroyed()) {
      this.shellWindow.close();
    }
    this.contentWindow = null;
    this.shellWindow = null;
    this.firstFrameReceived = false;
    this.showRequestedBeforeFirstFrame = false;
  }

  syncBounds(): void {
    if (!this.shellWindow || !this.contentWindow || this.shellWindow.isDestroyed() || this.contentWindow.isDestroyed()) {
      return;
    }
    this.contentWindow.setBounds(this.shellWindow.getBounds());
    this.requestInitialFrame('sync-bounds');
  }

  applyStealth(enabled: boolean): void {
    if (!this.shellWindow || this.shellWindow.isDestroyed()) {
      return;
    }
    this.stealthManager.applyToWindow(this.shellWindow, enabled, {
      role: 'primary',
      hideFromSwitcher: false,
      allowVirtualDisplayIsolation: false,
    });
  }

  private bindShellEvents(): void {
    this.boundInputHandler = (event, payload) => {
      if (!this.shellWindow || !this.contentWindow) {
        return;
      }
      if (event.sender.id !== this.shellWindow.webContents.id) {
        return;
      }
      this.inputBridge.forward(this.contentWindow.webContents as unknown as Parameters<InputBridge['forward']>[0], payload);
    };
    this.ipcMain.on('stealth-shell:input', this.boundInputHandler);

    this.boundReadyHandler = (event) => {
      if (!this.shellWindow || event.sender.id !== this.shellWindow.webContents.id) {
        return;
      }
      this.syncBounds();
      this.requestInitialFrame('shell-ready');
      this.emitHeartbeat();
    };
    this.ipcMain.on('stealth-shell:ready', this.boundReadyHandler);

    this.boundHeartbeatHandler = (event) => {
      if (!this.shellWindow || event.sender.id !== this.shellWindow.webContents.id) {
        return;
      }
      this.emitHeartbeat();
    };
    this.ipcMain.on('stealth-shell:heartbeat', this.boundHeartbeatHandler);
  }

  private requestInitialFrame(reason: string): void {
    if (!this.contentWindow || this.contentWindow.isDestroyed()) {
      return;
    }

    try {
      this.contentWindow.webContents.invalidate();
      this.logger.log(`[StealthRuntime] Requested content repaint (${reason})`);
    } catch (error) {
      this.logger.warn(`[StealthRuntime] Failed to request content repaint (${reason}):`, error);
    }
  }

  private handleContentCrash(reason: string): void {
    // Fail-closed: hide shell window immediately before propagating fault
    try {
      this.shellWindow?.hide();
      this.shellWindow?.setOpacity(0);
    } catch {
      // Best-effort: continue with fault propagation even if hide fails
    }
    this.emitFault(reason);
  }

  private emitFault(reason: string): void {
    if (!this.onFault) {
      // Defensive fallback: if onFault is not provided, hide shell and log critical error
      this.logger.error(`[StealthRuntime] CRITICAL: Fault with no handler, hiding shell window. Reason: ${reason}`);
      try {
        this.shellWindow?.hide();
        this.shellWindow?.setOpacity(0);
      } catch {
        // Best-effort
      }
      return;
    }

    Promise.resolve(this.onFault(reason)).catch((error) => {
      this.logger.warn(`[StealthRuntime] Failed to propagate runtime fault (${reason}):`, error);
    });
  }

  private emitHeartbeat(): void {
    if (!this.onHeartbeat) {
      return;
    }

    Promise.resolve(this.onHeartbeat()).catch((error) => {
      this.logger.warn('[StealthRuntime] Failed to propagate runtime heartbeat:', error);
    });
  }
}
