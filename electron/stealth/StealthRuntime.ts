import { BrowserWindow, app, ipcMain, type IpcMainEvent } from 'electron';
import path from 'node:path';

import { FrameBridge } from './frameBridge';
import { InputBridge } from './inputBridge';
import type { StealthInputEvent } from './types';
import type { StealthManager } from './StealthManager';

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
  | 'isVisible'
  | 'on'
  | 'once'
  | 'webContents'
>;

type RuntimeWindowFactory = (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;

interface RuntimeLogger {
  log: Console['log'];
  warn: Console['warn'];
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
  private readonly frameBridge: FrameBridge;
  private readonly inputBridge = new InputBridge();
  private contentWindow: BrowserWindow | null = null;
  private shellWindow: BrowserWindow | null = null;
  private contentWindowOptions: Electron.BrowserWindowConstructorOptions | null = null;
  private shellReady = false;
  private firstFramePresented = false;
  private pendingShow = false;
  private shellVisible = false;
  private contentRecoveryInFlight = false;
  private shellRecoveryInFlight = false;
  private boundInputHandler: ((event: IpcMainEvent, payload: StealthInputEvent) => void) | null = null;
  private boundReadyHandler: ((event: IpcMainEvent) => void) | null = null;
  private boundFramePresentedHandler: ((event: IpcMainEvent, payload: { frameId: number }) => void) | null = null;

  constructor(options: StealthRuntimeOptions) {
    this.stealthManager = options.stealthManager;
    this.startUrl = options.startUrl;
    this.shellHtmlPath = options.shellHtmlPath ?? path.join(app.getAppPath(), 'electron', 'renderer', 'shell.html');
    if (!this.shellHtmlPath.endsWith('.html') || this.shellHtmlPath.includes('..')) {
      throw new Error(`Invalid shellHtmlPath: ${this.shellHtmlPath}`);
    }
    this.createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
    this.logger = options.logger ?? console;
    this.preloadPath = options.preloadPath ?? path.join(__dirname, '../preload.js');
    this.shellPreloadPath = options.shellPreloadPath ?? path.join(__dirname, './shellPreload.js');
    this.ipcMain = options.ipcMain ?? ipcMain;
    this.frameBridge = new FrameBridge({
      target: {
        send: (channel, payload) => {
          this.shellWindow?.webContents.send(channel, payload);
        },
      },
      logger: this.logger,
      onFrameSent: () => {
        if (!this.shellVisible) {
          this.requestInitialFrame('frame-forwarded-while-hidden');
        }
      },
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
          backgroundThrottling: false,
        },
      });
      this.shellWindow = this.createWindow({
        ...shellOptions,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
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
    this.contentWindowOptions = {
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
        backgroundThrottling: false,
      },
    };
    this.shellReady = false;
    this.firstFramePresented = false;
    this.pendingShow = false;
    this.shellVisible = false;
    this.frameBridge.attach(this.contentWindow.webContents as unknown as Parameters<FrameBridge['attach']>[0]);
    this.bindShellEvents();

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

    this.bindContentWindowEvents(this.contentWindow);

    setTimeout(() => {
      if (!this.firstFramePresented) {
        this.logger.warn('[StealthRuntime] No presented frame received after 10s - shell remains hidden');
      }
    }, 10000);

    this.shellWindow.on('resize', () => this.syncBounds());
    this.shellWindow.on('move', () => this.syncBounds());
    this.shellWindow.on('closed', () => this.destroy());
    this.shellWindow.webContents.on('crashed', (_event, killed) => {
      this.logger.warn(`[StealthRuntime] Shell window crashed (killed=${killed})`);
      this.handleShellFailure('crashed');
    });
    this.shellWindow.webContents.on('render-process-gone', (_event, details) => {
      this.logger.warn(`[StealthRuntime] Shell render process gone: ${details.reason} exitCode=${details.exitCode}`);
      this.handleShellFailure(details.reason);
    });
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

  show(): void {
    if (!this.shellWindow || this.shellWindow.isDestroyed()) {
      return;
    }
    this.pendingShow = true;
    if (!this.shellReady || !this.firstFramePresented) {
      this.requestInitialFrame('show-request');
      return;
    }
    this.revealShellWindow();
  }

  hide(): void {
    this.pendingShow = false;
    this.shellVisible = false;
    this.shellWindow?.hide();
  }

  destroy(): void {
    this.frameBridge.detach();
    if (this.boundInputHandler) {
      this.ipcMain.removeListener('stealth-shell:input', this.boundInputHandler);
      this.boundInputHandler = null;
    }
    if (this.boundReadyHandler) {
      this.ipcMain.removeListener('stealth-shell:ready', this.boundReadyHandler);
      this.boundReadyHandler = null;
    }
    if (this.boundFramePresentedHandler) {
      this.ipcMain.removeListener('stealth-shell:frame-presented', this.boundFramePresentedHandler);
      this.boundFramePresentedHandler = null;
    }
    if (this.contentWindow && !this.contentWindow.isDestroyed()) {
      this.contentWindow.close();
    }
    if (this.shellWindow && !this.shellWindow.isDestroyed()) {
      this.shellWindow.close();
    }
    this.contentWindow = null;
    this.shellWindow = null;
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
      hideFromSwitcher: process.platform === 'win32' && enabled,
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
      this.shellReady = true;
      this.syncBounds();
      this.requestInitialFrame('shell-ready');
      this.revealShellWindow();
    };
    this.ipcMain.on('stealth-shell:ready', this.boundReadyHandler);

    this.boundFramePresentedHandler = (event, payload) => {
      if (!this.shellWindow || event.sender.id !== this.shellWindow.webContents.id) {
        return;
      }

      this.firstFramePresented = true;
      this.frameBridge.notifyPresented(payload.frameId);
      this.revealShellWindow();
    };
    this.ipcMain.on('stealth-shell:frame-presented', this.boundFramePresentedHandler);
  }

  private bindContentWindowEvents(contentWindow: BrowserWindow): void {
    contentWindow.webContents.on('did-finish-load', () => {
      this.logger.log('[StealthRuntime] Content window did-finish-load');
      this.requestInitialFrame('content-did-finish-load');
    });

    contentWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
      this.logger.warn(`[StealthRuntime] Content window did-fail-load: ${code} ${desc} URL: ${url}`);
    });

    contentWindow.webContents.on('crashed', (_event, killed) => {
      this.logger.warn(`[StealthRuntime] Content window crashed (killed=${killed})`);
      this.handleContentFailure('crashed');
    });

    contentWindow.webContents.on('render-process-gone', (_event, details) => {
      this.logger.warn(`[StealthRuntime] Content render process gone: ${details.reason} exitCode=${details.exitCode}`);
      this.handleContentFailure(details.reason);
    });
  }

  private revealShellWindow(): void {
    if (!this.pendingShow || !this.shellReady || !this.firstFramePresented || !this.shellWindow || this.shellWindow.isDestroyed()) {
      return;
    }

    this.shellWindow.show();
    this.shellWindow.focus();
    this.shellVisible = true;
    this.pendingShow = false;
  }

  private failClosedShell(): void {
    if (!this.shellWindow || this.shellWindow.isDestroyed()) {
      return;
    }

    this.pendingShow = false;
    this.shellVisible = false;
    try {
      this.shellWindow.setOpacity?.(0);
    } catch {
      // Ignore opacity issues during failure handling.
    }
    this.shellWindow.hide();
  }

  private handleContentFailure(reason: string): void {
    if (this.contentRecoveryInFlight || !this.contentWindowOptions) {
      return;
    }

    this.contentRecoveryInFlight = true;
    this.firstFramePresented = false;
    this.failClosedShell();
    this.pendingShow = true;

    try {
      if (this.contentWindow && !this.contentWindow.isDestroyed()) {
        this.contentWindow.close();
      }
    } catch {
      // Ignore close failures during recovery.
    }

    try {
      const contentWindow = this.createWindow(this.contentWindowOptions);
      this.contentWindow = contentWindow;
      this.frameBridge.attach(contentWindow.webContents as unknown as Parameters<FrameBridge['attach']>[0]);
      this.bindContentWindowEvents(contentWindow);
      void contentWindow.loadURL(this.startUrl).catch((error) => {
        this.logger.warn(`[StealthRuntime] Content recovery loadURL failed after ${reason}:`, error);
      });
      this.syncBounds();
      this.requestInitialFrame(`content-recovery:${reason}`);
    } finally {
      this.contentRecoveryInFlight = false;
    }
  }

  private handleShellFailure(reason: string): void {
    if (this.shellRecoveryInFlight || !this.shellWindow || this.shellWindow.isDestroyed()) {
      return;
    }

    this.shellRecoveryInFlight = true;
    this.shellReady = false;
    this.firstFramePresented = false;
    this.failClosedShell();
    this.pendingShow = true;

    void this.shellWindow.loadFile(this.shellHtmlPath)
      .catch((error) => {
        this.logger.warn(`[StealthRuntime] Shell recovery loadFile failed after ${reason}:`, error);
      })
      .finally(() => {
        this.shellRecoveryInFlight = false;
      });
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
}
