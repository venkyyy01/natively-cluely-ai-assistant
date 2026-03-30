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
  public nativeHandle: Buffer = Buffer.from([0x2a, 0, 0, 0, 0, 0, 0, 0]);
  public mediaSourceId = 'window:101:0';
  public destroyed = false;

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

  getNativeWindowHandle(): Buffer {
    return this.nativeHandle;
  }

  getMediaSourceId(): string {
    return this.mediaSourceId;
  }

  isDestroyed(): boolean {
    return this.destroyed;
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
});
