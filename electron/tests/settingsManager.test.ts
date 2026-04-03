import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

type ElectronAppMock = {
  isReady: () => boolean;
  getPath: (name: string) => string;
};

function installElectronMock(userDataPath: string, ready: boolean = true): () => void {
  const originalLoad = (Module as any)._load;
  const electronApp: ElectronAppMock = {
    isReady: () => ready,
    getPath: () => userDataPath,
  };

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return { app: electronApp };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

async function loadSettingsManager(userDataPath: string, ready: boolean = true) {
  const restoreElectron = installElectronMock(userDataPath, ready);
  const settingsModulePath = require.resolve('../services/SettingsManager');
  delete require.cache[settingsModulePath];

  const { SettingsManager } = await import('../services/SettingsManager');
  (SettingsManager as any).instance = undefined;

  return {
    SettingsManager,
    restoreElectron,
  };
}

test('SettingsManager preserves configured capture tool patterns as strings', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-patterns-validate-'));
  const settingsPath = path.join(userDataPath, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    captureToolPatterns: ['obs', 'screen studio'],
  }));

  const { SettingsManager, restoreElectron } = await loadSettingsManager(userDataPath);
  try {
    const settings = SettingsManager.getInstance();
    assert.deepEqual(settings.get('captureToolPatterns' as any), ['obs', 'screen studio']);
  } finally {
    restoreElectron();
  }
});

test('SettingsManager refuses to initialize before Electron is ready', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-not-ready-'));
  const { SettingsManager, restoreElectron } = await loadSettingsManager(userDataPath, false);

  try {
    assert.throws(() => SettingsManager.getInstance(), /Cannot initialize before app\.whenReady/);
  } finally {
    restoreElectron();
  }
});

test('SettingsManager sanitizes mixed persisted settings values', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-sanitize-'));
  const settingsPath = path.join(userDataPath, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    isUndetectable: false,
    consciousModeEnabled: true,
    accelerationModeEnabled: 'yes',
    enablePrivateMacosStealthApi: true,
    enableCaptureDetectionWatchdog: false,
    enableVirtualDisplayIsolation: true,
    captureToolPatterns: ['obs', '', 7, ' screen studio '],
    disguiseMode: 'activity',
    ignoredField: 'drop-me',
  }));

  const { SettingsManager, restoreElectron } = await loadSettingsManager(userDataPath);

  try {
    const settings = SettingsManager.getInstance();
    assert.equal(settings.get('isUndetectable'), false);
    assert.equal(settings.get('consciousModeEnabled'), true);
    assert.equal(settings.get('accelerationModeEnabled'), undefined);
    assert.equal(settings.getAccelerationModeEnabled(), false);
    assert.equal(settings.get('enablePrivateMacosStealthApi'), true);
    assert.equal(settings.get('enableCaptureDetectionWatchdog'), false);
    assert.equal(settings.get('enableVirtualDisplayIsolation'), true);
    assert.deepEqual(settings.get('captureToolPatterns'), ['obs', ' screen studio ']);
    assert.equal(settings.get('disguiseMode'), 'activity');
  } finally {
    restoreElectron();
  }
});

test('SettingsManager falls back to empty settings for non-object JSON payloads', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-invalid-json-shape-'));
  const settingsPath = path.join(userDataPath, 'settings.json');
  fs.writeFileSync(settingsPath, '123');

  const { SettingsManager, restoreElectron } = await loadSettingsManager(userDataPath);

  try {
    const settings = SettingsManager.getInstance();
    assert.equal(settings.get('disguiseMode'), undefined);
    assert.equal(settings.getAccelerationModeEnabled(), false);
  } finally {
    restoreElectron();
  }
});

test('SettingsManager rolls back failed saves without mutating in-memory settings', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-save-failure-'));
  const { SettingsManager, restoreElectron } = await loadSettingsManager(userDataPath);
  const originalRenameSync = fs.renameSync;

  try {
    const settings = SettingsManager.getInstance();
    fs.renameSync = ((..._args: Parameters<typeof fs.renameSync>) => {
      throw new Error('disk full');
    }) as typeof fs.renameSync;

    assert.equal(settings.set('disguiseMode', 'terminal'), false);
    assert.equal(settings.get('disguiseMode'), undefined);

    fs.renameSync = originalRenameSync;

    assert.equal(settings.set('disguiseMode', 'terminal'), true);
    assert.equal(settings.get('disguiseMode'), 'terminal');
  } finally {
    fs.renameSync = originalRenameSync;
    restoreElectron();
  }
});
