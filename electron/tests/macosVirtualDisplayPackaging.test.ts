import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMacosVirtualDisplayHelperPath } from '../stealth/macosVirtualDisplayIntegration';

test('resolveMacosVirtualDisplayHelperPath prefers packaged helper in resources', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    resourcesPath: '/Applications/Natively.app/Contents/Resources',
    pathExists: (candidate) => candidate === '/Applications/Natively.app/Contents/Resources/bin/macos/stealth-virtual-display-helper',
  });

  assert.equal(resolved, '/Applications/Natively.app/Contents/Resources/bin/macos/stealth-virtual-display-helper');
});

test('resolveMacosVirtualDisplayHelperPath falls back to local build output for dev', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    resourcesPath: '/Applications/Natively.app/Contents/Resources',
    pathExists: (candidate) => candidate === '/workspace/stealth-projects/macos-virtual-display-helper/.build/debug/stealth-virtual-display-helper',
  });

  assert.equal(resolved, '/workspace/stealth-projects/macos-virtual-display-helper/.build/debug/stealth-virtual-display-helper');
});
