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
