import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

import { setOptimizationFlagsForTesting } from '../config/optimizations';
import { StealthManager, type NativeStealthBindings, type StealthConfig } from '../stealth/StealthManager';

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

class FakeWindow extends EventEmitter {
  public contentProtectionCalls: boolean[] = [];
  public skipTaskbarCalls: boolean[] = [];
  public hiddenInMissionControlCalls: boolean[] = [];
  public excludedFromShownWindowsMenuCalls: boolean[] = [];
  public hideCalls = 0;
  public showCalls = 0;
  public setOpacityCalls: number[] = [];
  public nativeHandle: Buffer = Buffer.from([0x2a, 0, 0, 0, 0, 0, 0, 0]);
  public mediaSourceId = 'window:101:0';
  public destroyed = false;
  public visible = true;
  public bounds = { x: 10, y: 20, width: 1280, height: 720 };
  public setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }> = [];

  setContentProtection(value: boolean): void {
    this.contentProtectionCalls.push(value);
  }

  setSkipTaskbar(value: boolean): void {
    this.skipTaskbarCalls.push(value);
  }

  setHiddenInMissionControl(value: boolean): void {
    this.hiddenInMissionControlCalls.push(value);
  }

  setExcludedFromShownWindowsMenu(value: boolean): void {
    this.excludedFromShownWindowsMenuCalls.push(value);
  }

  setOpacity(value: number): void {
    this.setOpacityCalls.push(value);
    this.visible = value > 0;
  }

  getNativeWindowHandle(): Buffer {
    return this.nativeHandle;
  }

  getMediaSourceId(): string {
    return this.mediaSourceId;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  hide(): void {
    this.hideCalls += 1;
    this.visible = false;
  }

  show(): void {
    this.showCalls += 1;
    this.visible = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds };
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = { ...bounds };
    this.setBoundsCalls.push({ ...bounds });
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('closed');
  }
}

describe('StealthManager', () => {
  beforeEach(() => {
    setOptimizationFlagsForTesting({ accelerationEnabled: true, useStealthMode: true });
  });

  afterEach(() => {
    setOptimizationFlagsForTesting({ accelerationEnabled: false, useStealthMode: true });
  });

  it('returns stealth-ready window defaults when enabled', () => {
    const manager = new StealthManager({ enabled: true });
    const options = manager.getBrowserWindowOptions();

    assert.deepStrictEqual(options, {
      contentProtection: true,
      excludeFromCapture: true,
      skipTaskbar: false,
    });
  });

  it('does nothing when stealth is disabled', () => {
    const win = new FakeWindow();
    const manager = new StealthManager({ enabled: false });

    manager.applyToWindow(win as any);

    assert.deepStrictEqual(win.contentProtectionCalls, []);
    assert.deepStrictEqual(win.skipTaskbarCalls, []);
  });

  it('applies native Windows stealth and re-applies it on lifecycle events', () => {
    const calls: string[] = [];
    const nativeModule: NativeStealthBindings = {
      applyWindowsWindowStealth(handle: Buffer) {
        calls.push(`apply:${handle.readUInt8(0)}`);
      },
    };
    const win = new FakeWindow();
    const manager = new StealthManager({ enabled: true }, { nativeModule, platform: 'win32', logger: silentLogger });

    manager.applyToWindow(win as any, true, { role: 'primary' });
    win.emit('restore');
    win.emit('unminimize');
    win.emit('move');

    assert.deepStrictEqual(win.contentProtectionCalls, [true, true, true, true]);
    assert.deepStrictEqual(calls, ['apply:42', 'apply:42', 'apply:42', 'apply:42']);
  });

  it('applies auxiliary UI hardening on macOS windows', () => {
    const nativeModule: NativeStealthBindings = {
      applyMacosWindowStealth(windowNumber: number) {
        assert.strictEqual(windowNumber, 101);
      },
    };
    const win = new FakeWindow();
    const manager = new StealthManager({ enabled: true }, { nativeModule, platform: 'darwin', logger: silentLogger });

    manager.applyToWindow(win as any, true, { role: 'auxiliary' });

    assert.deepStrictEqual(win.contentProtectionCalls, [true]);
    assert.deepStrictEqual(win.skipTaskbarCalls, [true]);
    assert.deepStrictEqual(win.hiddenInMissionControlCalls, [true]);
    assert.deepStrictEqual(win.excludedFromShownWindowsMenuCalls, [true]);
  });

  it('falls back cleanly when native stealth throws', () => {
    const win = new FakeWindow();
    const manager = new StealthManager(
      { enabled: true },
      {
        nativeModule: {
          applyWindowsWindowStealth() {
            throw new Error('boom');
          },
        },
        logger: silentLogger,
        platform: 'win32',
      }
    );

    assert.doesNotThrow(() => manager.applyToWindow(win as any, true, { role: 'primary' }));
    assert.deepStrictEqual(win.contentProtectionCalls, [true]);
  });

  it('reapplies managed windows after power monitor events', () => {
    const nativeCalls: number[] = [];
    const powerMonitor = new EventEmitter();
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'win32',
        powerMonitor,
        nativeModule: {
          applyWindowsWindowStealth() {
            nativeCalls.push(Date.now());
          },
        },
        logger: silentLogger,
      }
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary' });
    powerMonitor.emit('unlock-screen');
    powerMonitor.emit('resume');

    assert.strictEqual(nativeCalls.length, 3);
  });

  it('reapplies managed windows after display metrics changes on Windows', () => {
    const nativeCalls: number[] = [];
    const displayEvents = new EventEmitter();
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'win32',
        displayEvents,
        nativeModule: {
          applyWindowsWindowStealth() {
            nativeCalls.push(Date.now());
          },
        },
        logger: silentLogger,
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary' });
    displayEvents.emit('display-metrics-changed');

    assert.strictEqual(nativeCalls.length, 2);
  });

  it('reapplies managed windows after screen-api display metrics changes on Windows', () => {
    const nativeCalls: number[] = [];
    const screenApi = new EventEmitter() as EventEmitter & {
      getAllDisplays: () => Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }>;
    };
    screenApi.getAllDisplays = () => [];

    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'win32',
        screenApi,
        nativeModule: {
          applyWindowsWindowStealth() {
            nativeCalls.push(Date.now());
          },
        },
        logger: silentLogger,
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary' });
    screenApi.emit('display-metrics-changed');

    assert.strictEqual(nativeCalls.length, 2);
  });

  it('reapplies managed windows after macOS display add and remove events', () => {
    const nativeCalls: number[] = [];
    const displayEvents = new EventEmitter();
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        displayEvents,
        nativeModule: {
          applyMacosWindowStealth() {
            nativeCalls.push(Date.now());
          },
        },
        logger: silentLogger,
      } as any,
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary' });
    displayEvents.emit('display-added');
    displayEvents.emit('display-removed');

    assert.strictEqual(nativeCalls.length, 3);
  });

  it('enables the private macOS stealth path only when the feature flag is set', () => {
    const nativeCalls: string[] = [];
    const nativeModule: NativeStealthBindings = {
      applyMacosWindowStealth() {
        nativeCalls.push('base');
      },
      applyMacosPrivateWindowStealth() {
        nativeCalls.push('private');
      },
    };
    const win = new FakeWindow();

    const disabledManager = new StealthManager(
      { enabled: true },
      { nativeModule, platform: 'darwin', logger: silentLogger }
    );
    disabledManager.applyToWindow(win as any, true, { role: 'primary' });

    const enabledManager = new StealthManager(
      { enabled: true },
      {
        nativeModule,
        platform: 'darwin',
        logger: silentLogger,
        featureFlags: { enablePrivateMacosStealthApi: true },
      }
    );
    enabledManager.applyToWindow(win as any, true, { role: 'primary' });

    assert.deepStrictEqual(nativeCalls, ['base', 'base', 'private']);
  });

  it('starts the capture watchdog and hides then restores visible windows on detection', async () => {
        const powerMonitor = new EventEmitter();
        const intervals: Array<() => Promise<void> | void> = [];
        const timeouts: Array<() => void> = [];
        const manager = new StealthManager(
            { enabled: true },
            {
                platform: 'darwin',
                powerMonitor,
                logger: silentLogger,
                featureFlags: { enableCaptureDetectionWatchdog: true },
                intervalScheduler: (fn: () => Promise<void> | void) => {
                    intervals.push(fn);
                    return intervals.length;
                },
                clearIntervalScheduler() {},
                timeoutScheduler: (fn: () => void) => {
                    timeouts.push(fn);
                    return timeouts.length;
                },
                processEnumerator: async () => 'obs',
            } as any
        );
        const win = new FakeWindow();

        manager.applyToWindow(win as any, true, { role: 'primary' });
        assert.strictEqual(intervals.length, 1);

        await intervals[0]();
        assert.deepStrictEqual(win.setOpacityCalls, [0]);

        timeouts[0]();
        assert.deepStrictEqual(win.setOpacityCalls, [0, 1]);
    });

    it('uses a configurable capture tool matcher list for watchdog detection', async () => {
        const intervals: Array<() => Promise<void> | void> = [];
        const win = new FakeWindow();
        const manager = new StealthManager(
            { enabled: true },
            {
                platform: 'darwin',
                logger: silentLogger,
                featureFlags: { enableCaptureDetectionWatchdog: false },
                captureToolPatterns: [/internal recorder/i],
                intervalScheduler: (fn: () => Promise<void> | void) => {
                    intervals.push(fn);
                    return intervals.length;
                },
                clearIntervalScheduler() {},
                timeoutScheduler() {
                    return 1;
                },
                processEnumerator: async () => '',
            } as any
        );

        manager.applyToWindow(win as any, true, { role: 'primary' });
        assert.strictEqual(intervals.length, 0);
    });

    it('logs capture detections when the watchdog hides windows', async () => {
        const intervals: Array<() => Promise<void> | void> = [];
        const logs: string[] = [];
        const manager = new StealthManager(
            { enabled: true },
            {
                platform: 'darwin',
                logger: {
                    log(message: string) {
                        logs.push(message);
                    },
                    warn() {},
                    error() {},
                },
                featureFlags: { enableCaptureDetectionWatchdog: true },
                intervalScheduler: (fn: () => Promise<void> | void) => {
                    intervals.push(fn);
                    return intervals.length;
                },
                clearIntervalScheduler() {},
                timeoutScheduler() {
                    return 1;
                },
                processEnumerator: async () => 'obs',
            } as any
        );
        const win = new FakeWindow();

        manager.applyToWindow(win as any, true, { role: 'primary' });
        await intervals[0]();

        assert.ok(logs.some((entry) => entry.includes('Capture watchdog detected suspicious tools running')));
    });

  it('verifies applied stealth state through native bindings', () => {
    const win = new FakeWindow();
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        logger: silentLogger,
        nativeModule: {
          applyMacosWindowStealth() {},
          verifyMacosStealthState() {
            return 0;
          },
        },
      },
    );

    manager.applyToWindow(win as any, true, { role: 'primary' });

    assert.strictEqual(manager.verifyStealth(win as any), true);
  });

  it('falls back to hide and show when opacity APIs are unavailable', async () => {
    const intervals: Array<() => Promise<void> | void> = [];
    const timeouts: Array<() => void> = [];
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        logger: silentLogger,
        featureFlags: { enableCaptureDetectionWatchdog: true },
        intervalScheduler: (fn: () => Promise<void> | void) => {
          intervals.push(fn);
          return intervals.length;
        },
        clearIntervalScheduler() {},
        timeoutScheduler: (fn: () => void) => {
          timeouts.push(fn);
          return timeouts.length;
        },
        processEnumerator: async () => 'obs',
      } as any,
    );
    const win = new FakeWindow() as FakeWindow & { setOpacity?: undefined };
    delete win.setOpacity;

    manager.applyToWindow(win as any, true, { role: 'primary' });
    await intervals[0]();
    timeouts[0]();

    assert.strictEqual(win.hideCalls, 1);
    assert.strictEqual(win.showCalls, 1);
  });

  it('verifies Windows stealth state through native bindings', () => {
    const win = new FakeWindow();
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'win32',
        logger: silentLogger,
        nativeModule: {
          applyWindowsWindowStealth() {},
          verifyWindowsStealthState() {
            return 0x11;
          },
        },
      },
    );

    manager.applyToWindow(win as any, true, { role: 'primary' });

    assert.strictEqual(manager.verifyStealth(win as any), true);
  });

  it('starts macOS virtual display isolation with the current window bounds when the feature flag is enabled', async () => {
    const calls: Array<{ action: string; windowId: string; width?: number; height?: number }> = [];
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        screenApi: {
          getAllDisplays() {
            return [{ id: 777, workArea: { x: 200, y: 100, width: 1600, height: 900 } }];
          },
        },
        logger: silentLogger,
        featureFlags: { enableVirtualDisplayIsolation: true },
        virtualDisplayCoordinator: {
          ensureIsolationForWindow({ windowId, width, height }: { windowId: string; width: number; height: number }) {
            calls.push({ action: 'ensure', windowId, width, height });
            return Promise.resolve({ ready: true, sessionId: windowId, mode: 'virtual-display' as const, surfaceToken: 'display-777' });
          },
          releaseIsolationForWindow({ windowId }: { windowId: string }) {
            calls.push({ action: 'release', windowId });
            return Promise.resolve();
          },
        },
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary', allowVirtualDisplayIsolation: true });
    await Promise.resolve();
    manager.applyToWindow(win as any, false, { role: 'primary', allowVirtualDisplayIsolation: true });

    assert.deepStrictEqual(calls, [
      { action: 'ensure', windowId: 'window:101:0', width: 1280, height: 720 },
      { action: 'release', windowId: 'window:101:0' },
    ]);
    assert.deepStrictEqual(win.setBoundsCalls, [
      { x: 200, y: 100, width: 1280, height: 720 },
    ]);
  });

  it('retries moving macOS windows to the virtual display until Electron reports the display', async () => {
    const timeouts: Array<() => void> = [];
    const displays: Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }> = [];
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        screenApi: {
          getAllDisplays() {
            return [...displays];
          },
        },
        logger: silentLogger,
        featureFlags: { enableVirtualDisplayIsolation: true },
        timeoutScheduler: (fn: () => void) => {
          timeouts.push(fn);
          return timeouts.length;
        },
        virtualDisplayCoordinator: {
          ensureIsolationForWindow({ windowId }: { windowId: string }) {
            return Promise.resolve({ ready: true, sessionId: windowId, mode: 'virtual-display' as const, surfaceToken: 'display-777' });
          },
          releaseIsolationForWindow() {
            return Promise.resolve();
          },
        },
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary', allowVirtualDisplayIsolation: true });
    await Promise.resolve();

    assert.deepStrictEqual(win.setBoundsCalls, []);
    assert.strictEqual(timeouts.length, 1);

    displays.push({ id: 777, workArea: { x: 200, y: 100, width: 1600, height: 900 } });
    timeouts[0]();

    assert.deepStrictEqual(win.setBoundsCalls, [
      { x: 200, y: 100, width: 1280, height: 720 },
    ]);
  });

  it('does not start virtual display isolation unless the window opts in', async () => {
    const calls: Array<{ action: string; windowId: string }> = [];
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        logger: silentLogger,
        featureFlags: { enableVirtualDisplayIsolation: true },
        virtualDisplayCoordinator: {
          ensureIsolationForWindow({ windowId }: { windowId: string }) {
            calls.push({ action: 'ensure', windowId });
            return Promise.resolve({ ready: true, sessionId: windowId, mode: 'virtual-display' as const, surfaceToken: 'display-777' });
          },
          releaseIsolationForWindow({ windowId }: { windowId: string }) {
            calls.push({ action: 'release', windowId });
            return Promise.resolve();
          },
        },
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary' });
    await Promise.resolve();
    manager.applyToWindow(win as any, false, { role: 'primary' });

    assert.deepStrictEqual(calls, []);
  });

  it('retries virtual display isolation after a non-ready helper response', async () => {
    const calls: string[] = [];
    let ready = false;
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        screenApi: {
          getAllDisplays() {
            return [{ id: 777, workArea: { x: 200, y: 100, width: 1600, height: 900 } }];
          },
        },
        logger: silentLogger,
        featureFlags: { enableVirtualDisplayIsolation: true },
        virtualDisplayCoordinator: {
          ensureIsolationForWindow({ windowId }: { windowId: string }) {
            calls.push(ready ? 'ready' : 'not-ready');
            if (ready) {
              return Promise.resolve({ ready: true, sessionId: windowId, mode: 'virtual-display' as const, surfaceToken: 'display-777' });
            }
            return Promise.resolve({ ready: false, sessionId: windowId, reason: 'warming-up' });
          },
          releaseIsolationForWindow() {
            return Promise.resolve();
          },
        },
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary', allowVirtualDisplayIsolation: true });
    await Promise.resolve();

    ready = true;
    manager.reapplyAfterShow(win as any);
    await Promise.resolve();

    assert.deepStrictEqual(calls, ['not-ready', 'ready']);
    assert.deepStrictEqual(win.setBoundsCalls, [
      { x: 200, y: 100, width: 1280, height: 720 },
    ]);
  });

  it('cancels pending virtual display moves when stealth is disabled', async () => {
    const timeouts: Array<() => void> = [];
    const displays: Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }> = [];
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        screenApi: {
          getAllDisplays() {
            return [...displays];
          },
        },
        logger: silentLogger,
        featureFlags: { enableVirtualDisplayIsolation: true },
        timeoutScheduler: (fn: () => void) => {
          timeouts.push(fn);
          return timeouts.length;
        },
        virtualDisplayCoordinator: {
          ensureIsolationForWindow({ windowId }: { windowId: string }) {
            return Promise.resolve({ ready: true, sessionId: windowId, mode: 'virtual-display' as const, surfaceToken: 'display-777' });
          },
          releaseIsolationForWindow() {
            return Promise.resolve();
          },
        },
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary', allowVirtualDisplayIsolation: true });
    await Promise.resolve();
    manager.applyToWindow(win as any, false, { role: 'primary', allowVirtualDisplayIsolation: true });

    displays.push({ id: 777, workArea: { x: 200, y: 100, width: 1600, height: 900 } });
    timeouts[0]();

    assert.deepStrictEqual(win.setBoundsCalls, []);
  });

  it('allows virtual display isolation to retry after display move retries are exhausted', async () => {
    const calls: string[] = [];
    const timeouts: Array<() => void> = [];
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        screenApi: {
          getAllDisplays(): Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }> {
            return [];
          },
        },
        logger: silentLogger,
        featureFlags: { enableVirtualDisplayIsolation: true },
        timeoutScheduler: (fn: () => void) => {
          timeouts.push(fn);
          return timeouts.length;
        },
        virtualDisplayCoordinator: {
          ensureIsolationForWindow({ windowId }: { windowId: string }) {
            calls.push(windowId);
            return Promise.resolve({ ready: true, sessionId: windowId, mode: 'virtual-display' as const, surfaceToken: 'display-777' });
          },
          releaseIsolationForWindow() {
            return Promise.resolve();
          },
        },
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary', allowVirtualDisplayIsolation: true });
    await Promise.resolve();

    for (let i = 0; i < 10; i += 1) {
      timeouts[i]();
    }

    manager.reapplyAfterShow(win as any);
    await Promise.resolve();

    assert.deepStrictEqual(calls, ['window:101:0', 'window:101:0']);
  });

  it('releases virtual display isolation when an opted-in window closes', async () => {
    const calls: Array<{ action: string; windowId: string }> = [];
    const manager = new StealthManager(
      { enabled: true },
      {
        platform: 'darwin',
        logger: silentLogger,
        featureFlags: { enableVirtualDisplayIsolation: true },
        virtualDisplayCoordinator: {
          ensureIsolationForWindow({ windowId }: { windowId: string }) {
            calls.push({ action: 'ensure', windowId });
            return Promise.resolve({ ready: true, sessionId: windowId, mode: 'virtual-display' as const, surfaceToken: 'display-777' });
          },
          releaseIsolationForWindow({ windowId }: { windowId: string }) {
            calls.push({ action: 'release', windowId });
            return Promise.resolve();
          },
        },
      } as any
    );
    const win = new FakeWindow();

    manager.applyToWindow(win as any, true, { role: 'primary', allowVirtualDisplayIsolation: true });
    await Promise.resolve();
    win.destroy();

    assert.deepStrictEqual(calls, [
      { action: 'ensure', windowId: 'window:101:0' },
      { action: 'release', windowId: 'window:101:0' },
    ]);
  });
});
