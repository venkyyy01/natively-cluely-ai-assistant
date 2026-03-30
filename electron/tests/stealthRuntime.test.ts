import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { StealthRuntime } from '../stealth/StealthRuntime';

class FakeWebContents extends EventEmitter {
  public id: number;
  public sent: Array<{ channel: string; payload: unknown }> = [];

  constructor(id: number) {
    super();
    this.id = id;
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  sendInputEvent(): void {}
  setFrameRate(): void {}
}

class FakeWindow extends EventEmitter {
  public webContents: FakeWebContents;
  public bounds = { x: 1, y: 2, width: 300, height: 200 };
  public hidden = false;
  public shown = false;
  public destroyed = false;

  constructor(id: number) {
    super();
    this.webContents = new FakeWebContents(id);
  }

  loadURL(): Promise<void> { return Promise.resolve(); }
  loadFile(): Promise<void> { return Promise.resolve(); }
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

test('StealthRuntime creates shell/content pair and applies stealth to both windows', () => {
  const created: FakeWindow[] = [];
  const applied: Array<{ id: number; options: unknown }> = [];
  const runtime = new StealthRuntime({
    startUrl: 'http://localhost:5180?window=launcher',
    stealthManager: {
      applyToWindow(win: { webContents: { id: number } }, _enabled: boolean, options: unknown) {
        applied.push({ id: win.webContents.id, options });
      },
    } as never,
    createWindow: () => {
      const win = new FakeWindow(created.length + 1);
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
  assert.deepEqual(applied, [
    { id: 2, options: { role: 'primary', hideFromSwitcher: false, allowVirtualDisplayIsolation: false } },
    { id: 1, options: { role: 'auxiliary', hideFromSwitcher: true, allowVirtualDisplayIsolation: true } },
  ]);
  assert.deepEqual(created[0]?.bounds, created[1]?.bounds);
});

test('StealthRuntime ignores shell events from unrelated senders and cleans up safely', () => {
  const ipcBus = new EventEmitter();
  const created: FakeWindow[] = [];
  const runtime = new StealthRuntime({
    startUrl: 'http://localhost:5180?window=launcher',
    stealthManager: { applyToWindow() {} } as never,
    createWindow: () => {
      const win = new FakeWindow(created.length + 11);
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
  runtime.hide();
  ipcBus.emit('stealth-shell:ready', { sender: { id: 999 } });
  ipcBus.emit('stealth-shell:input', { sender: { id: 999 } }, { kind: 'focus', type: 'focus' });
  runtime.destroy();
  runtime.destroy();

  assert.equal(created[1]?.shown, true);
  assert.equal(created[1]?.hidden, true);
});
