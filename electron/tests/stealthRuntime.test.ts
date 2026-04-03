import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { StealthRuntime } from '../stealth/StealthRuntime';

class FakeWebContents extends EventEmitter {
  public id: number;
  public sent: Array<{ channel: string; payload: unknown }> = [];
  public invalidations = 0;

  constructor(id: number) {
    super();
    this.id = id;
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  sendInputEvent(): void {}
  setFrameRate(): void {}
  invalidate(): void { this.invalidations += 1; }
}

class FakeWindow extends EventEmitter {
  public webContents: FakeWebContents;
  public bounds = { x: 1, y: 2, width: 300, height: 200 };
  public hidden = false;
  public shown = false;
  public destroyed = false;
  public loadUrls: string[] = [];
  public loadFiles: string[] = [];
  public options: Record<string, unknown>;

  constructor(id: number, options: Record<string, unknown>) {
    super();
    this.webContents = new FakeWebContents(id);
    this.options = options;
  }

  loadURL(url?: string): Promise<void> {
    if (url) this.loadUrls.push(url);
    return Promise.resolve();
  }
  loadFile(file?: string): Promise<void> {
    if (file) this.loadFiles.push(file);
    return Promise.resolve();
  }
  show(): void { this.shown = true; }
  hide(): void { this.hidden = true; }
  close(): void { this.destroyed = true; }
  focus(): void {}
  setBounds(bounds: typeof this.bounds): void { this.bounds = bounds; }
  getBounds(): typeof this.bounds { return this.bounds; }
  setOpacity(): void {}
  setAlwaysOnTop(): void {}
  isDestroyed(): boolean { return this.destroyed; }
}

test('StealthRuntime creates shell/content pair and applies stealth to the visible shell only', () => {
  const created: FakeWindow[] = [];
  const applied: Array<{ id: number; options: unknown }> = [];
  const runtime = new StealthRuntime({
    startUrl: 'http://localhost:5180?window=launcher',
    stealthManager: {
      applyToWindow(win: { webContents: { id: number } }, _enabled: boolean, options: unknown) {
        applied.push({ id: win.webContents.id, options });
      },
    } as never,
    createWindow: (options) => {
      const win = new FakeWindow(created.length + 1, options as Record<string, unknown>);
      created.push(win);
      return win as never;
    },
    shellHtmlPath: '/tmp/shell.html',
    preloadPath: '/tmp/preload.js',
    shellPreloadPath: '/tmp/shellPreload.js',
    ipcMain: new EventEmitter() as never,
    logger: { log() {}, warn() {} },
  });

  const shell = runtime.createPrimaryStealthSurface({ width: 100, height: 100, webPreferences: {} });
  runtime.applyStealth(true);
  runtime.syncBounds();

  assert.equal(created.length, 2);
  assert.equal(shell.webContents.id, 2);
  assert.equal(created[0]?.options.paintWhenInitiallyHidden, true);
  assert.equal(created[0]?.options.transparent, false);
  assert.equal(created[0]?.options.frame, false);
  assert.equal(created[0]?.options.vibrancy, undefined);
  assert.deepEqual(applied, [
    { id: 2, options: { role: 'primary', hideFromSwitcher: false, allowVirtualDisplayIsolation: false } },
  ]);
  assert.deepEqual(created[0]?.bounds, created[1]?.bounds);
});

test('StealthRuntime ignores shell events from unrelated senders and cleans up safely', () => {
  const ipcBus = new EventEmitter();
  const created: FakeWindow[] = [];
  const runtime = new StealthRuntime({
    startUrl: 'http://localhost:5180?window=launcher',
    stealthManager: { applyToWindow() {} } as never,
    createWindow: (options) => {
      const win = new FakeWindow(created.length + 11, options as Record<string, unknown>);
      created.push(win);
      return win as never;
    },
    shellHtmlPath: '/tmp/shell.html',
    preloadPath: '/tmp/preload.js',
    shellPreloadPath: '/tmp/shellPreload.js',
    ipcMain: ipcBus as never,
    logger: { log() {}, warn() {} },
  });

  runtime.createPrimaryStealthSurface({ width: 100, height: 100, webPreferences: {} });
  runtime.show();
  ipcBus.emit('stealth-shell:ready', { sender: { id: created[1]?.webContents.id } });
  ipcBus.emit('stealth-shell:frame-presented', { sender: { id: created[1]?.webContents.id } }, { frameId: 1 });
  runtime.hide();
  ipcBus.emit('stealth-shell:ready', { sender: { id: 999 } });
  ipcBus.emit('stealth-shell:input', { sender: { id: 999 } }, { kind: 'focus', type: 'focus' });
  runtime.destroy();
  runtime.destroy();

  assert.equal(created[1]?.shown, true);
  assert.equal(created[1]?.hidden, true);
});

test('StealthRuntime requests an initial repaint after content load and shell ready', () => {
  const ipcBus = new EventEmitter();
  const created: FakeWindow[] = [];
  const runtime = new StealthRuntime({
    startUrl: 'http://localhost:5180?window=launcher',
    stealthManager: { applyToWindow() {} } as never,
    createWindow: (options) => {
      const win = new FakeWindow(created.length + 31, options as Record<string, unknown>);
      created.push(win);
      return win as never;
    },
    shellHtmlPath: '/tmp/shell.html',
    preloadPath: '/tmp/preload.js',
    shellPreloadPath: '/tmp/shellPreload.js',
    ipcMain: ipcBus as never,
    logger: { log() {}, warn() {} },
  });

  runtime.createPrimaryStealthSurface({ width: 100, height: 100, transparent: true, vibrancy: 'under-window', webPreferences: {} });
  created[0]?.webContents.emit('did-finish-load');
  ipcBus.emit('stealth-shell:ready', { sender: { id: created[1]?.webContents.id } });

  assert.equal(created[0]?.webContents.invalidations, 3);
});

test('StealthRuntime uses loadURL for packaged file targets so query params survive', () => {
  const created: FakeWindow[] = [];
  const runtime = new StealthRuntime({
    startUrl: 'file:///Applications/Natively.app/Contents/Resources/app.asar/dist/index.html?window=launcher',
    stealthManager: { applyToWindow() {} } as never,
    createWindow: (options) => {
      const win = new FakeWindow(created.length + 21, options as Record<string, unknown>);
      created.push(win);
      return win as never;
    },
    shellHtmlPath: '/tmp/shell.html',
    preloadPath: '/tmp/preload.js',
    shellPreloadPath: '/tmp/shellPreload.js',
    ipcMain: new EventEmitter() as never,
    logger: { log() {}, warn() {} },
  });

  runtime.createPrimaryStealthSurface({ width: 100, height: 100, webPreferences: {} });

  assert.deepEqual(created[0]?.loadUrls, [
    'file:///Applications/Natively.app/Contents/Resources/app.asar/dist/index.html?window=launcher',
  ]);
  assert.deepEqual(created[0]?.loadFiles, []);
});
