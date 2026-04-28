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
          isReady: () => true,
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

test('AppState invisible enable commits to local-visible protected controls', async () => {
  const restoreElectron = installElectronMock();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  try {
    const { AppState } = await import('../main');
    const { SettingsManager } = await import('../services/SettingsManager');
    const originalGetInstance = SettingsManager.getInstance;
    const prototype = AppState.prototype as any;
    const applyUndetectableState = prototype.applyUndetectableState as (
      this: any,
      state: boolean,
      startedAt: number,
      metadata?: Record<string, unknown>,
    ) => void;

    const calls: string[] = [];
    (SettingsManager as any).getInstance = () => ({
      set(key: string, value: unknown) {
        calls.push(`persist:${key}:${value}`);
        return true;
      },
    });

    const fakeState: any = {
      isUndetectable: false,
      syncWindowStealthProtection(state: boolean) {
        calls.push(`syncProtection:${state}`);
      },
      clearPrivacyShieldFault() {
        calls.push('clearFault');
      },
      clearDisguiseTimers() {
        calls.push('clearDisguiseTimers');
      },
      requestVisibilityIntent(intent: string, source: string) {
        calls.push(`intent:${intent}:${source}`);
      },
      _broadcastToAllWindows(channel: string, payload: unknown) {
        calls.push(`broadcast:${channel}:${payload}`);
      },
      performanceInstrumentation: {
        recordDuration(metric: string, startedAt: number, metadata: Record<string, unknown>) {
          calls.push(`duration:${metric}:${startedAt}:${metadata.runtime}`);
        },
      },
      windowHelper: {
        getVisibleMainWindow: (): null => null,
      },
      settingsWindowHelper: {
        getSettingsWindow: (): null => null,
        closeWindow() {
          calls.push('closeSettings');
        },
        setIgnoreBlur() {},
      },
      modelSelectorWindowHelper: {
        getWindow: (): null => null,
        hideWindow() {
          calls.push('hideModelSelector');
        },
        setIgnoreBlur() {},
      },
      hideTray() {
        calls.push('hideTray');
      },
      showTray() {
        calls.push('showTray');
      },
      scheduleDisguiseTimer(callback: () => void) {
        callback();
      },
    };

    try {
      applyUndetectableState.call(fakeState, true, 123, { runtime: 'test' });
    } finally {
      (SettingsManager as any).getInstance = originalGetInstance;
    }

    assert.equal(fakeState.isUndetectable, true);
    assert.ok(calls.includes('syncProtection:true'));
    assert.ok(calls.includes('persist:isUndetectable:true'));
    assert.ok(calls.includes('intent:visible_safe_controls:undetectable_enabled'));
    assert.ok(!calls.some((call) => call.includes('intent:protected_shield')));
  } finally {
    restoreElectron();
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('AppState visible_safe_controls intent shows the protected local UI instead of hiding it', async () => {
  const restoreElectron = installElectronMock();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  try {
    const { AppState } = await import('../main');
    const requestVisibilityIntent = (AppState.prototype as any).requestVisibilityIntent as (
      this: any,
      intent: string,
      source: string,
    ) => void;

    const calls: string[] = [];
    const fakeState: any = {
      visibilityIntent: 'protected_hidden',
      privacyShieldFaultReason: null,
      stealthManager: {
        recordProtectionEvent(type: string, context?: { reason?: string }) {
          calls.push(`event:${type}:${context?.reason ?? 'unknown'}`);
        },
      },
      setContainmentActive(active: boolean, source: string) {
        calls.push(`containment:${active}:${source}`);
      },
      syncWindowStealthProtection(state: boolean) {
        calls.push(`syncProtection:${state}`);
      },
      syncPrivacyShieldState() {
        calls.push('syncPrivacyShield');
      },
      showMainWindow() {
        calls.push('showMainWindow');
      },
      windowHelper: {
        hideMainWindow() {
          calls.push('hideMainWindow');
        },
      },
      _broadcastToAllWindows(channel: string, payload: { to: string }) {
        calls.push(`broadcast:${channel}:${payload.to}`);
      },
      abortActiveInferenceStreams(reason: string) {
        calls.push(`abort:${reason}`);
      },
    };

    requestVisibilityIntent.call(fakeState, 'visible_safe_controls', 'test');

    assert.equal(fakeState.visibilityIntent, 'visible_safe_controls');
    assert.deepEqual(calls, [
      'event:show-requested:visible_safe_controls',
      'containment:false:test',
      'syncProtection:true',
      'syncPrivacyShield',
      'showMainWindow',
      'broadcast:visibility-intent-changed:visible_safe_controls',
    ]);
  } finally {
    restoreElectron();
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('AppState startup stealth recovery clears containment for visible safe controls', async () => {
  const restoreElectron = installElectronMock();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  try {
    const { AppState } = await import('../main');
    const bindRuntimeCoordinatorEvents = (AppState.prototype as any).bindRuntimeCoordinatorEvents as (this: any) => void;

    const subscriptions = new Map<string, (event: any) => Promise<void>>();
    const calls: string[] = [];
    const fakeState: any = {
      privacyShieldFaultReason: 'startup containment',
      visibilityIntent: 'visible_safe_controls',
      runtimeCoordinator: {
        getBus() {
          return {
            subscribe(type: string, callback: (event: any) => Promise<void>) {
              subscriptions.set(type, callback);
            },
          };
        },
      },
      setContainmentActive(active: boolean, source: string) {
        calls.push(`containment:${active}:${source}`);
      },
      syncPrivacyShieldState() {
        calls.push('syncPrivacyShield');
      },
      privacyShieldRecoveryController: {
        update() {
          calls.push('recoveryUpdate');
        },
      },
      _broadcastToAllWindows(channel: string, payload: { to: string }) {
        calls.push(`broadcast:${channel}:${payload.to}`);
      },
      performanceInstrumentation: {
        recordEvent(metric: string, payload: { to?: string }) {
          calls.push(`metric:${metric}:${payload.to ?? 'unknown'}`);
        },
      },
    };

    bindRuntimeCoordinatorEvents.call(fakeState);
    await subscriptions.get('stealth:state-changed')?.({ from: 'ARMING', to: 'FULL_STEALTH' });

    assert.equal(fakeState.privacyShieldFaultReason, null);
    assert.deepEqual(calls, [
      'containment:false:stealth_recovered',
      'syncPrivacyShield',
      'recoveryUpdate',
      'broadcast:stealth-state-changed:FULL_STEALTH',
      'metric:stealth.state:FULL_STEALTH',
    ]);
  } finally {
    restoreElectron();
    process.env.NODE_ENV = originalNodeEnv;
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
