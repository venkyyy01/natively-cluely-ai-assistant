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
  private boundInputHandler: ((event: IpcMainEvent, payload: StealthInputEvent) => void) | null = null;
  private boundReadyHandler: ((event: IpcMainEvent) => void) | null = null;

  constructor(options: StealthRuntimeOptions) {
    this.stealthManager = options.stealthManager;
    this.startUrl = options.startUrl;
    this.shellHtmlPath = options.shellHtmlPath ?? path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'electron', 'renderer', 'shell.html');
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
    });
  }

  createPrimaryStealthSurface(options: Electron.BrowserWindowConstructorOptions): RuntimeWindow {
    if (this.shellWindow && !this.shellWindow.isDestroyed()) {
      return this.shellWindow;
    }

    const { webPreferences, show, ...shellOptions } = options;
    let contentWindow: BrowserWindow | null = null;
    try {
      contentWindow = this.createWindow({
        ...shellOptions,
        show: false,
        webPreferences: {
          ...webPreferences,
          preload: this.preloadPath,
          offscreen: true,
          backgroundThrottling: false,
        },
        skipTaskbar: true,
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
    this.frameBridge.attach(this.contentWindow.webContents as unknown as Parameters<FrameBridge['attach']>[0]);
    this.bindShellEvents();

    void this.contentWindow.loadURL(this.startUrl);
    void this.shellWindow.loadFile(this.shellHtmlPath);

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

  show(): void {
    if (!this.shellWindow || this.shellWindow.isDestroyed()) {
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
    if (this.boundInputHandler) {
      this.ipcMain.removeListener('stealth-shell:input', this.boundInputHandler);
      this.boundInputHandler = null;
    }
    if (this.boundReadyHandler) {
      this.ipcMain.removeListener('stealth-shell:ready', this.boundReadyHandler);
      this.boundReadyHandler = null;
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

    if (this.contentWindow && !this.contentWindow.isDestroyed()) {
      this.stealthManager.applyToWindow(this.contentWindow, enabled, {
        role: 'auxiliary',
        hideFromSwitcher: true,
        allowVirtualDisplayIsolation: true,
      });
    }
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
    };
    this.ipcMain.on('stealth-shell:ready', this.boundReadyHandler);
  }
}
