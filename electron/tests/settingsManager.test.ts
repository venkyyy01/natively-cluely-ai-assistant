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

function installElectronMock(userDataPath: string): () => void {
  const originalLoad = (Module as any)._load;
  const electronApp: ElectronAppMock = {
    isReady: () => true,
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

test('SettingsManager preserves configured capture tool patterns as strings', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-patterns-validate-'));
  const settingsPath = path.join(userDataPath, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    captureToolPatterns: ['obs', 'screen studio'],
  }));

  const restoreElectron = installElectronMock(userDataPath);
  const settingsModulePath = require.resolve('../services/SettingsManager');
  delete require.cache[settingsModulePath];

  try {
    const { SettingsManager } = await import('../services/SettingsManager');
    (SettingsManager as any).instance = undefined;

    const settings = SettingsManager.getInstance();
    assert.deepEqual(settings.get('captureToolPatterns' as any), ['obs', 'screen studio']);
  } finally {
    restoreElectron();
  }
});
