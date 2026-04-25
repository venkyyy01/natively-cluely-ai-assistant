import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

function installElectronMock(): () => void {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: true,
          getAppPath(): string {
            return '/tmp';
          },
          getPath(): string {
            return '/tmp';
          },
          whenReady: async (): Promise<void> => undefined,
          on() {},
          commandLine: {
            appendSwitch() {},
          },
          dock: {
            show() {},
            hide() {},
          },
          quit() {},
          exit() {},
        },
        BrowserWindow: {
          getAllWindows: (): unknown[] => [],
        },
        Tray: class {},
        Menu: {},
        nativeImage: {},
        ipcMain: {},
        shell: {},
        systemPreferences: {},
        globalShortcut: {},
        session: {},
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

test('AppState strict invisible enable hides, protects, verifies, and does not commit on failed verification', async () => {
  const restoreElectron = installElectronMock();
  const originalNodeEnv = process.env.NODE_ENV;
  const previousStrict = process.env.NATIVELY_STRICT_PROTECTION;
  process.env.NODE_ENV = 'test';
  process.env.NATIVELY_STRICT_PROTECTION = '1';

  try {
    const { AppState } = await import('../main');
    const prototype = AppState.prototype as any;
    const setUndetectableAsync = prototype.setUndetectableAsync as (this: any, state: boolean) => Promise<void>;
    const hideForUndetectableEnable = prototype.hideForUndetectableEnable as (this: any) => void;
    const verifyUndetectableEnableProtection = prototype.verifyUndetectableEnableProtection as (this: any) => void;

    const calls: string[] = [];
    const fakeState: any = {
      isUndetectable: false,
      pendingUndetectableState: null,
      undetectableToggleMutex: Promise.resolve(),
      runtimeCoordinator: {
        getSupervisor() {
          return {
            getState: () => 'running',
            start: async () => {
              calls.push('start');
            },
            setEnabled: async (state: boolean) => {
              calls.push(`setEnabled:${state}`);
            },
          };
        },
      },
      stealthManager: {
        recordProtectionEvent(type: string, context?: { source?: string }) {
          calls.push(`event:${type}:${context?.source ?? 'unknown'}`);
        },
      },
      windowHelper: {
        hideMainWindow() {
          calls.push('hideMainWindow');
        },
      },
      settingsWindowHelper: {
        closeWindow() {
          calls.push('hideSettings');
        },
      },
      modelSelectorWindowHelper: {
        hideWindow() {
          calls.push('hideModelSelector');
        },
      },
      syncWindowStealthProtection(state: boolean) {
        calls.push(`syncProtection:${state}`);
      },
      verifyStealthProtection() {
        calls.push('verifyProtection');
        return false;
      },
      isStrictProtectionEnabled: () => true,
      setPrivacyShieldFault(key: string) {
        calls.push(`privacyFault:${key}`);
      },
      hideForUndetectableEnable() {
        return hideForUndetectableEnable.call(this);
      },
      verifyUndetectableEnableProtection() {
        return verifyUndetectableEnableProtection.call(this);
      },
      prepareUndetectableDisableProtection() {
        calls.push('prepareDisable');
      },
      applyUndetectableState(state: boolean) {
        calls.push(`apply:${state}`);
      },
    };

    await assert.rejects(
      () => setUndetectableAsync.call(fakeState, true),
      /Invisible mode protection could not be verified/,
    );

    assert.deepEqual(calls, [
      'event:hide-requested:AppState.hideForUndetectableEnable',
      'hideMainWindow',
      'hideSettings',
      'hideModelSelector',
      'syncProtection:true',
      'setEnabled:true',
      'verifyProtection',
      'event:verification-failed:AppState.verifyUndetectableEnableProtection',
      'privacyFault:undetectable_enable_verification_failed',
    ]);
    assert.equal(fakeState.isUndetectable, false);
    assert.equal(fakeState.pendingUndetectableState, null);
  } finally {
    restoreElectron();
    process.env.NODE_ENV = originalNodeEnv;
    if (previousStrict === undefined) {
      delete process.env.NATIVELY_STRICT_PROTECTION;
    } else {
      process.env.NATIVELY_STRICT_PROTECTION = previousStrict;
    }
  }
});

test('AppState serializes opposite invisible toggle targets without interleaving', async () => {
  const restoreElectron = installElectronMock();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  try {
    const { AppState } = await import('../main');
    const setUndetectableAsync = (AppState.prototype as any).setUndetectableAsync as (
      this: any,
      state: boolean,
    ) => Promise<void>;

    const calls: string[] = [];
    let releaseFirstToggle: (() => void) | null = null;
    const firstToggleStarted = new Promise<void>((resolve) => {
      releaseFirstToggle = resolve;
    });

    const fakeState: any = {
      isUndetectable: false,
      pendingUndetectableState: null,
      undetectableToggleMutex: Promise.resolve(),
      runtimeCoordinator: {
        getSupervisor() {
          return {
            getState: () => 'running',
            start: async () => {},
            setEnabled: async (state: boolean) => {
              calls.push(`setEnabled:${state}:start`);
              if (state) {
                await firstToggleStarted;
              }
              calls.push(`setEnabled:${state}:end`);
            },
          };
        },
      },
      hideForUndetectableEnable() {
        calls.push('hideForEnable');
      },
      syncWindowStealthProtection(state: boolean) {
        calls.push(`syncProtection:${state}`);
      },
      verifyUndetectableEnableProtection() {
        calls.push('verifyEnable');
      },
      prepareUndetectableDisableProtection() {
        calls.push('prepareDisable');
      },
      applyUndetectableState(state: boolean) {
        calls.push(`apply:${state}`);
        this.isUndetectable = state;
      },
    };

    const enablePromise = setUndetectableAsync.call(fakeState, true);
    const disablePromise = setUndetectableAsync.call(fakeState, false);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [
      'hideForEnable',
      'syncProtection:true',
      'setEnabled:true:start',
    ]);

    releaseFirstToggle?.();
    await Promise.all([enablePromise, disablePromise]);

    assert.deepEqual(calls, [
      'hideForEnable',
      'syncProtection:true',
      'setEnabled:true:start',
      'setEnabled:true:end',
      'verifyEnable',
      'apply:true',
      'setEnabled:false:start',
      'setEnabled:false:end',
      'prepareDisable',
      'apply:false',
    ]);
    assert.equal(fakeState.isUndetectable, false);
    assert.equal(fakeState.pendingUndetectableState, null);
  } finally {
    restoreElectron();
    process.env.NODE_ENV = originalNodeEnv;
  }
});
