import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { StealthRuntime } from '../stealth/StealthRuntime';
import { StealthSupervisor } from '../runtime/StealthSupervisor';
import { SupervisorBus } from '../runtime/SupervisorBus';

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
  invalidate(): void {}
}

class FakeWindow extends EventEmitter {
  public webContents: FakeWebContents;
  public bounds = { x: 1, y: 2, width: 300, height: 200 };
  public hidden = false;
  public shown = false;
  public destroyed = false;
  public loadUrls: string[] = [];
  public loadFiles: string[] = [];

  constructor(id: number) {
    super();
    this.webContents = new FakeWebContents(id);
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

function createRuntimeHarness(
  onFault?: (reason: string) => void | Promise<void>,
  options: { startUrl?: string } = {},
) {
  const ipcBus = new EventEmitter();
  const created: FakeWindow[] = [];
  const runtime = new StealthRuntime({
    startUrl: options.startUrl ?? 'http://localhost:5180?window=launcher',
    stealthManager: { applyToWindow() {} } as never,
    createWindow: () => {
      const win = new FakeWindow(created.length + 1);
      created.push(win);
      return win as never;
    },
    shellHtmlPath: '/tmp/shell.html',
    preloadPath: '/tmp/preload.js',
    shellPreloadPath: '/tmp/shellPreload.js',
    ipcMain: ipcBus as never,
    logger: { log() {}, warn() {} },
    onFault,
  });

  runtime.createPrimaryStealthSurface({ width: 100, height: 100, webPreferences: {} });

  return {
    runtime,
    created,
    ipcBus,
  };
}

test('active renderer lifecycle: start/stop and shell readiness remain deterministic', () => {
  const { runtime, created, ipcBus } = createRuntimeHarness();

  runtime.show();
  runtime.hide();
  ipcBus.emit('stealth-shell:ready', { sender: { id: created[1]?.webContents.id } });
  runtime.destroy();

  assert.equal(created.length, 2);
  assert.equal(created[1]?.shown, true);
  assert.equal(created[1]?.hidden, true);
  assert.equal(created[0]?.destroyed, true);
  assert.equal(created[1]?.destroyed, true);
});

test('active renderer lifecycle: content crash triggers fail-closed supervisor fault exit', async () => {
  const bus = new SupervisorBus({ error() {} });
  const faults: string[] = [];
  const calls: boolean[] = [];

  bus.subscribe('stealth:fault', async (event) => {
    faults.push(event.reason);
  });

  const supervisor = new StealthSupervisor(
    {
      async setEnabled(enabled: boolean) {
        calls.push(enabled);
      },
      isEnabled: () => calls[calls.length - 1] ?? false,
      verifyStealthState: () => true,
    },
    bus,
    {
      heartbeatIntervalMs: 1,
      intervalScheduler: () => ({ unref() {} }),
      clearIntervalScheduler: () => {},
    },
  );

  await supervisor.start();
  await supervisor.setEnabled(true);
  assert.equal(supervisor.getStealthState(), 'FULL_STEALTH');

  const { created } = createRuntimeHarness((reason) => supervisor.reportFault(new Error(reason)));
  created[0]?.webContents.emit('crashed', {}, false);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(supervisor.getStealthState(), 'FAULT');
  assert.deepEqual(faults, ['content-window-crashed']);
});

test('active renderer lifecycle: rapid shell restarts keep teardown deterministic', () => {
  const first = createRuntimeHarness();
  first.runtime.destroy();

  const second = createRuntimeHarness();
  second.runtime.destroy();

  assert.equal(first.created[0]?.destroyed, true);
  assert.equal(first.created[1]?.destroyed, true);
  assert.equal(second.created[0]?.destroyed, true);
  assert.equal(second.created[1]?.destroyed, true);
});

test('active renderer lifecycle: packaged renderer preserves file URL query target', () => {
  const startUrl = 'file:///Applications/Natively.app/Contents/Resources/app.asar/dist/index.html?window=launcher';
  const { runtime, created } = createRuntimeHarness(undefined, { startUrl });
  runtime.destroy();

  assert.deepEqual(created[0]?.loadUrls, [startUrl]);
  assert.deepEqual(created[0]?.loadFiles, []);
});
