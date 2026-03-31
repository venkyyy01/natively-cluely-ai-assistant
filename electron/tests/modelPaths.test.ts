import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { isElectronAppPackaged, resolveBundledModelsPath } from '../utils/modelPaths';

type ElectronAppMock = {
  isPackaged: boolean;
  getAppPath: () => string;
};

function installElectronMock(app: ElectronAppMock | null): () => void {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      if (app === null) {
        throw new Error('electron unavailable');
      }

      return { app };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

function withResourcesPath(resourcesPath: string, run: () => void): void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });

  try {
    run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'resourcesPath', originalDescriptor);
    } else {
      delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    }
  }
}

test('modelPaths resolves packaged builds from process.resourcesPath', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-paths-packaged-'));
  const resourcesPath = path.join(tempRoot, 'Resources');
  fs.mkdirSync(path.join(resourcesPath, 'models'), { recursive: true });

  const restoreElectron = installElectronMock({
    isPackaged: true,
    getAppPath: () => path.join(tempRoot, 'app'),
  });

  try {
    withResourcesPath(resourcesPath, () => {
      assert.equal(resolveBundledModelsPath(), path.join(resourcesPath, 'models'));
      assert.equal(isElectronAppPackaged(), true);
    });
  } finally {
    restoreElectron();
  }
});

test('modelPaths prefers the working tree resources directory when unpackaged', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-paths-cwd-'));
  const cwdModelsPath = path.join(fs.realpathSync(tempRoot), 'resources', 'models');
  const appRoot = path.join(tempRoot, 'mock-app');
  fs.mkdirSync(cwdModelsPath, { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'resources', 'models'), { recursive: true });

  const originalCwd = process.cwd();
  const restoreElectron = installElectronMock({
    isPackaged: false,
    getAppPath: () => appRoot,
  });

  process.chdir(tempRoot);
  try {
    assert.equal(resolveBundledModelsPath(), cwdModelsPath);
  } finally {
    process.chdir(originalCwd);
    restoreElectron();
  }
});

test('modelPaths falls back to the Electron app resources directory when cwd models are absent', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-paths-app-'));
  const appRoot = path.join(tempRoot, 'mock-app');
  const appModelsPath = path.join(appRoot, 'resources', 'models');
  fs.mkdirSync(appModelsPath, { recursive: true });

  const originalCwd = process.cwd();
  const restoreElectron = installElectronMock({
    isPackaged: false,
    getAppPath: () => appRoot,
  });

  process.chdir(tempRoot);
  try {
    assert.equal(resolveBundledModelsPath(), appModelsPath);
  } finally {
    process.chdir(originalCwd);
    restoreElectron();
  }
});

test('modelPaths falls back cleanly when Electron is unavailable', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-paths-no-electron-'));
  const originalCwd = process.cwd();
  const restoreElectron = installElectronMock(null);

  process.chdir(tempRoot);
  try {
    assert.match(resolveBundledModelsPath(), /resources[\\/]models$/);
    assert.equal(isElectronAppPackaged(), false);
  } finally {
    process.chdir(originalCwd);
    restoreElectron();
  }
});

test('modelPaths returns the first candidate when no bundled model directory exists yet', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-paths-missing-'));
  const originalCwd = process.cwd();
  const originalExistsSync = fs.existsSync;
  const restoreElectron = installElectronMock({
    isPackaged: false,
    getAppPath: () => path.join(tempRoot, 'mock-app'),
  });

  process.chdir(tempRoot);
  fs.existsSync = (() => false) as typeof fs.existsSync;
  try {
    assert.equal(resolveBundledModelsPath(), path.join(process.cwd(), 'resources', 'models'));
  } finally {
    fs.existsSync = originalExistsSync;
    process.chdir(originalCwd);
    restoreElectron();
  }
});
