const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadAdHocSign() {
  const modulePath = require.resolve('../ad-hoc-sign.js');
  delete require.cache[modulePath];
  return require('../ad-hoc-sign.js').default;
}

test('ad-hoc-sign skips non-mac packaging targets even on a macOS host', async () => {
  const adHocSign = loadAdHocSign();
  await assert.doesNotReject(async () => {
    await adHocSign({
      electronPlatformName: 'win32',
      appOutDir: '/tmp/win-unpacked',
      packager: {
        appInfo: {
          productFilename: 'Natively',
        },
        info: {
          projectDir: '/tmp/project',
        },
      },
    });
  });
});

test('ad-hoc-sign signs packaged foundation intent helper when present', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hoc-sign-foundation-intent-'));
  const appOutDir = tempDir;
  const appName = 'Natively';
  const appPath = path.join(appOutDir, `${appName}.app`);
  const helperPath = path.join(appPath, 'Contents', 'Resources', 'bin', 'macos', 'foundation-intent-helper');
  const entitlementsPath = path.join(tempDir, 'assets', 'entitlements.mac.plist');
  const projectAssetsDir = path.dirname(entitlementsPath);

  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.mkdirSync(projectAssetsDir, { recursive: true });
  fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(helperPath, 0o755);
  fs.writeFileSync(entitlementsPath, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict></dict></plist>\n`);

  const originalExecSync = childProcess.execSync;
  const calls = [];
  childProcess.execSync = (command) => {
    calls.push(command);
    return Buffer.from('');
  };

  try {
    const adHocSign = loadAdHocSign();
    await adHocSign({
      electronPlatformName: 'darwin',
      appOutDir,
      packager: {
        appInfo: {
          productFilename: appName,
        },
        info: {
          projectDir: tempDir,
        },
      },
    });
  } finally {
    childProcess.execSync = originalExecSync;
  }

  assert.equal(calls.some((command) => command.includes('foundation-intent-helper')), true);
});
