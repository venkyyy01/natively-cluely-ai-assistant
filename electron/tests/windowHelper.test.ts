import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  const originalResourcesPath = process.resourcesPath;
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/tmp/resources';

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
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
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
    (helper as any).directLauncherLoaded = true;
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

test('WindowHelper defers direct launcher show requests until the renderer load completes', async () => {
  const restoreElectron = installElectronMock();
  const windowHelperPath = require.resolve('../WindowHelper');
  delete require.cache[windowHelperPath];

  try {
    const { WindowHelper } = await import('../WindowHelper');
    const helper = new WindowHelper({} as never, { applyToWindow() {}, reapplyAfterShow() {} } as never);

    let launcherShown = 0;

    (helper as any).launcherRuntime = null;
    (helper as any).directLauncherLoaded = false;
    (helper as any).launcherWindow = {
      isDestroyed: () => false,
      show() { launcherShown += 1; },
      focus() {},
      setOpacity() {},
      hide() {},
    };
    (helper as any).overlayWindow = {
      isDestroyed: () => false,
      hide() {},
    };

    helper.switchToLauncher();

    assert.equal(launcherShown, 0);
    assert.equal((helper as any).pendingDirectLauncherReveal, true);
    assert.equal(helper.isVisible(), false);
  } finally {
    restoreElectron();
  }
});

test('WindowHelper reveals the direct launcher after did-finish-load when a show request is pending', async () => {
  const restoreElectron = installElectronMock();
  const windowHelperPath = require.resolve('../WindowHelper');
  delete require.cache[windowHelperPath];

  try {
    const { WindowHelper } = await import('../WindowHelper');
    const helper = new WindowHelper({} as never, { applyToWindow() {}, reapplyAfterShow() {} } as never);

    class FakeWebContents extends EventEmitter {
      executeJavaScript(): Promise<boolean> {
        return Promise.resolve(true);
      }

      reloadIgnoringCache(): void {}
    }

    class FakeWindow extends EventEmitter {
      public webContents = new FakeWebContents();

      isDestroyed(): boolean {
        return false;
      }

      setOpacity(): void {}
      hide(): void {}
      show(): void {}
      focus(): void {}
      setIgnoreMouseEvents(): void {}
      setFocusable(): void {}
      blur(): void {}
      setVisibleOnAllWorkspaces(): void {}
      setAlwaysOnTop(): void {}
      setBounds(): void {}

      getBounds() {
        return { x: 0, y: 0, width: 600, height: 300 };
      }

      close(): void {}
    }

    let launcherShown = 0;
    let launcherFocused = 0;
    const launcherWindow = new FakeWindow();
    launcherWindow.show = () => {
      launcherShown += 1;
    };
    launcherWindow.focus = () => {
      launcherFocused += 1;
    };

    const overlayWindow = new FakeWindow();
    overlayWindow.show = () => {};
    overlayWindow.focus = () => {};
    overlayWindow.setBounds = () => {};
    overlayWindow.hide = () => {};

    const appState = {
      getDisguise: () => 'none',
      handleStealthRuntimeFault() {},
      settingsWindowHelper: { reposition() {} },
    };

    (helper as any).appState = appState;
    let windowCreationCount = 0;
    (helper as any).createDirectWindow = () => {
      windowCreationCount += 1;
      return windowCreationCount === 1 ? launcherWindow : overlayWindow;
    };
    (helper as any).loadDirectWindow = () => {};
    (helper as any).currentWindowMode = 'launcher';

    helper.createWindow();

    assert.equal((helper as any).directLauncherLoaded, false);
    assert.equal((helper as any).pendingDirectLauncherReveal, true);

    launcherWindow.webContents.emit('did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((helper as any).directLauncherLoaded, true);
    assert.equal((helper as any).pendingDirectLauncherReveal, false);
    assert.equal(launcherShown, 1);
    assert.equal(launcherFocused, 2);
  } finally {
    restoreElectron();
  }
});

test('WindowHelper blocks startup launcher reveal in strict mode when verification fails', async () => {
  const restoreElectron = installElectronMock();
  const windowHelperPath = require.resolve('../WindowHelper');
  delete require.cache[windowHelperPath];
  const previousStrict = process.env.NATIVELY_STRICT_PROTECTION;
  process.env.NATIVELY_STRICT_PROTECTION = '1';

  try {
    const { WindowHelper } = await import('../WindowHelper');

    class FakeWebContents extends EventEmitter {
      executeJavaScript(): Promise<boolean> {
        return Promise.resolve(true);
      }

      reloadIgnoringCache(): void {}
    }

    class FakeWindow extends EventEmitter {
      public webContents = new FakeWebContents();

      isDestroyed(): boolean {
        return false;
      }

      setOpacity(): void {}
      hide(): void {}
      show(): void {}
      focus(): void {}
      setIgnoreMouseEvents(): void {}
      setFocusable(): void {}
      blur(): void {}
      setVisibleOnAllWorkspaces(): void {}
      setAlwaysOnTop(): void {}
      setBounds(): void {}

      getBounds() {
        return { x: 0, y: 0, width: 600, height: 300 };
      }

      close(): void {}
    }

    let launcherShown = 0;
    const launcherWindow = new FakeWindow();
    launcherWindow.show = () => {
      launcherShown += 1;
    };

    const overlayWindow = new FakeWindow();
    let windowCreationCount = 0;
    const privacyFaults: Array<{ key: string; reason: string }> = [];
    const stealthEvents: string[] = [];

    const appState = {
      getDisguise: () => 'none',
      handleStealthRuntimeFault() {},
      settingsWindowHelper: { reposition() {} },
      shouldStartRendererShielded: () => false,
      getVisibilityIntent: () => 'visible_app',
      setPrivacyShieldFault(key: string, reason: string) {
        privacyFaults.push({ key, reason });
      },
    };

    const helper = new WindowHelper(appState as never, {
      applyToWindow() {},
      reapplyAfterShow() {},
      verifyManagedWindows() {
        return false;
      },
      recordProtectionEvent(type: string) {
        stealthEvents.push(type);
      },
    } as never);

    (helper as any).createDirectWindow = () => {
      windowCreationCount += 1;
      return windowCreationCount === 1 ? launcherWindow : overlayWindow;
    };
    (helper as any).loadDirectWindow = () => {};
    (helper as any).currentWindowMode = 'launcher';

    helper.createWindow();

    launcherWindow.webContents.emit('did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(launcherShown, 0);
    assert.equal((helper as any).pendingDirectLauncherReveal, false);
    assert.deepEqual(privacyFaults.map((fault) => fault.key), ['startup_protection_verification_failed']);
    assert.ok(stealthEvents.includes('verification-failed'));
  } finally {
    if (previousStrict === undefined) {
      delete process.env.NATIVELY_STRICT_PROTECTION;
    } else {
      process.env.NATIVELY_STRICT_PROTECTION = previousStrict;
    }
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
