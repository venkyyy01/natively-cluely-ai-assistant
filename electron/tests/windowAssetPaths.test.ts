import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getWindowAssetCandidates,
  resolveRendererPreloadPath,
  resolveRendererStartUrl,
  resolveStealthShellPreloadPath,
} from '../runtime/windowAssetPaths';

test('window asset paths prefer unpacked preloads in packaged builds', () => {
  const appPath = '/Applications/Natively.app/Contents/Resources/app.asar';
  const resourcesPath = '/Applications/Natively.app/Contents/Resources';
  const unpackedPreload = '/Applications/Natively.app/Contents/Resources/app.asar.unpacked/dist-electron/electron/preload.js';
  const unpackedShellPreload = '/Applications/Natively.app/Contents/Resources/app.asar.unpacked/dist-electron/electron/stealth/shellPreload.js';
  const rendererEntry = '/Applications/Natively.app/Contents/Resources/app.asar/dist/index.html';
  const existing = new Set<string>([unpackedPreload, unpackedShellPreload, rendererEntry]);

  const context = {
    electronDir: '/Applications/Natively.app/Contents/Resources/app.asar/dist-electron/electron',
    isPackaged: true,
    nodeEnv: 'production',
    appPath,
    resourcesPath,
    fileExists: (filePath: string) => existing.has(filePath),
  };

  const candidates = getWindowAssetCandidates(context);
  assert.equal(candidates.preload[0], unpackedPreload);
  assert.equal(resolveRendererPreloadPath(context), unpackedPreload);
  assert.equal(resolveStealthShellPreloadPath(context), unpackedShellPreload);
  assert.equal(resolveRendererStartUrl(context), 'file:///Applications/Natively.app/Contents/Resources/app.asar/dist/index.html');
});

test('window asset paths encode file URLs safely for paths with spaces', () => {
  const rendererEntry = '/tmp/Natively Preview/dist/index.html';
  const context = {
    electronDir: '/tmp/Natively Preview/dist-electron/electron',
    isPackaged: false,
    nodeEnv: 'production',
    appPath: '/tmp/Natively Preview',
    resourcesPath: '/tmp/Natively Preview/resources',
    fileExists: (filePath: string) => filePath === rendererEntry,
  };

  assert.equal(resolveRendererStartUrl(context), 'file:///tmp/Natively%20Preview/dist/index.html');
});

test('window asset paths keep development renderer startup on the Vite server', () => {
  const compiledPreload = '/repo/dist-electron/electron/preload.js';
  const context = {
    electronDir: '/repo/dist-electron/electron',
    isPackaged: false,
    nodeEnv: 'development',
    appPath: '/repo',
    resourcesPath: '/repo/resources',
    fileExists: (filePath: string) => filePath === compiledPreload,
  };

  assert.equal(resolveRendererStartUrl(context), 'http://localhost:5180');
  assert.equal(resolveRendererPreloadPath(context), compiledPreload);
});

test('window asset paths tolerate missing process.resourcesPath outside Electron-managed contexts', () => {
  const context = {
    electronDir: '/tmp/build/dist-electron/electron',
    isPackaged: false,
    nodeEnv: 'production',
    appPath: '/tmp/build',
    fileExists: () => false,
  };

  assert.equal(resolveRendererStartUrl(context), 'file:///tmp/build/dist/index.html');
  assert.equal(resolveRendererPreloadPath(context), '/tmp/build/dist-electron/electron/preload.js');
});
