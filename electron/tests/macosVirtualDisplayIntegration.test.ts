import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMacosVirtualDisplayHelperPath } from '../stealth/macosVirtualDisplayIntegration';

test('resolveMacosVirtualDisplayHelperPath prefers explicit env override', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: { NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER: '/tmp/helper' },
    pathExists: () => true,
    cwd: '/workspace',
  });

  assert.equal(resolved, '/tmp/helper');
});

test('resolveMacosVirtualDisplayHelperPath falls back to the local Swift build output', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    pathExists: (candidate) => candidate.endsWith('/stealth-projects/macos-virtual-display-helper/.build/debug/stealth-virtual-display-helper'),
  });

  assert.match(resolved ?? '', /stealth-virtual-display-helper$/);
});
