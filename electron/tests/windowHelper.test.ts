import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

function installElectronMock(): () => void {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        BrowserWindow: class BrowserWindow {},
        screen: {
          getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        },
        app: {
          isPackaged: false,
          getAppPath: () => '/tmp/app',
        },
        ipcMain: { on() {}, removeListener() {} },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

test('WindowHelper treats overlay as a primary stealth surface', async () => {
  const restoreElectron = installElectronMock();
  const windowHelperPath = require.resolve('../WindowHelper');
  delete require.cache[windowHelperPath];

  try {
    const { WindowHelper } = await import('../WindowHelper');
    const calls: Array<{ enable: boolean; role?: string; hideFromSwitcher?: boolean }> = [];
    const fakeStealthManager = {
      applyToWindow(_win: unknown, enable: boolean, options: { role?: string; hideFromSwitcher?: boolean }) {
        calls.push({ enable, role: options.role, hideFromSwitcher: options.hideFromSwitcher });
      },
    };

    const helper = new WindowHelper({} as never, fakeStealthManager as never);
    (helper as any).launcherWindow = { isDestroyed: () => false };
    (helper as any).overlayWindow = { isDestroyed: () => false };

    helper.setContentProtection(true);

    assert.deepEqual(calls, [
      { enable: true, role: 'primary', hideFromSwitcher: false },
      { enable: true, role: 'primary', hideFromSwitcher: false },
    ]);
  } finally {
    restoreElectron();
  }
});

test('WindowHelper centers overlay using the overlay height', async () => {
  const restoreElectron = installElectronMock();
  const windowHelperPath = require.resolve('../WindowHelper');
  delete require.cache[windowHelperPath];

  try {
    const { WindowHelper } = await import('../WindowHelper');
    const helper = new WindowHelper({} as never, { applyToWindow() {}, reapplyAfterShow() {} } as never);
    let appliedBounds: { x: number; y: number; width: number; height: number } | null = null;

    (helper as any).overlayWindow = {
      isDestroyed: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 600, height: 300 }),
      setBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
        appliedBounds = bounds;
      },
      setIgnoreMouseEvents() {},
      setFocusable() {},
      blur() {},
      show() {},
      focus() {},
      setAlwaysOnTop() {},
    };
    (helper as any).overlayRuntime = {
      applyStealth() {},
    };
    (helper as any).launcherWindow = {
      isDestroyed: () => false,
      hide() {},
    };

    helper.switchToOverlay();

    assert.deepEqual(appliedBounds, { x: 420, y: 300, width: 600, height: 300 });
  } finally {
    restoreElectron();
  }
});

test('WindowHelper can show and hide a direct launcher window when StealthRuntime is unavailable', async () => {
  const restoreElectron = installElectronMock();
  const windowHelperPath = require.resolve('../WindowHelper');
  delete require.cache[windowHelperPath];

  try {
    const { WindowHelper } = await import('../WindowHelper');
    const stealthCalls: Array<{ enable: boolean; role?: string }> = [];
    const helper = new WindowHelper({} as never, {
      applyToWindow(_win: unknown, enable: boolean, options: { role?: string }) {
        stealthCalls.push({ enable, role: options.role });
      },
      reapplyAfterShow() {},
    } as never);

    let launcherShown = 0;
    let launcherHidden = 0;
    let launcherFocused = 0;
    let overlayHidden = 0;

    (helper as any).launcherRuntime = null;
    (helper as any).launcherWindow = {
      isDestroyed: () => false,
      show() { launcherShown += 1; },
      hide() { launcherHidden += 1; },
      focus() { launcherFocused += 1; },
      setOpacity() {},
    };
    (helper as any).overlayWindow = {
      isDestroyed: () => false,
      hide() { overlayHidden += 1; },
    };

    helper.switchToLauncher();
    helper.hideMainWindow();

    assert.deepEqual(stealthCalls, [{ enable: false, role: 'primary' }]);
    assert.equal(launcherShown, 1);
    assert.equal(launcherFocused, 2);
    assert.equal(launcherHidden, 1);
    assert.equal(overlayHidden, 2);
  } finally {
    restoreElectron();
  }
});

test('WindowHelper forwards stealth runtime heartbeat events to the registered listener', async () => {
  const restoreElectron = installElectronMock();
  const windowHelperPath = require.resolve('../WindowHelper');
  delete require.cache[windowHelperPath];

  try {
    const { WindowHelper } = await import('../WindowHelper');
    const helper = new WindowHelper({} as never, { applyToWindow() {}, reapplyAfterShow() {} } as never);
    let heartbeatCount = 0;

    helper.setStealthRuntimeHeartbeatListener(() => {
      heartbeatCount += 1;
    });

    const listener = (helper as any).stealthHeartbeatListener as (() => void) | null;
    listener?.();
    listener?.();

    assert.equal(heartbeatCount, 2);
  } finally {
    restoreElectron();
  }
});
