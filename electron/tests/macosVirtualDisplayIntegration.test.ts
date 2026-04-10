import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMacosVirtualDisplayHelperPath, createMacosVirtualDisplayCoordinator } from '../stealth/macosVirtualDisplayIntegration';
import { MacosVirtualDisplayClient, MacosVirtualDisplayCoordinator } from '../stealth/MacosVirtualDisplayClient';

test('resolveMacosVirtualDisplayHelperPath checks packaged XPC helper candidates before extraResources helper', () => {
  const checkedCandidates: string[] = [];
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    resourcesPath: '/Applications/Natively.app/Contents/Resources',
    pathExists: (candidate) => {
      checkedCandidates.push(candidate);
      return candidate === '/Applications/Natively.app/Contents/XPCServices/macos-full-stealth-helper.xpc/Contents/MacOS/macos-full-stealth-helper';
    },
  });

  assert.equal(resolved, '/Applications/Natively.app/Contents/XPCServices/macos-full-stealth-helper.xpc/Contents/MacOS/macos-full-stealth-helper');
  assert.equal(checkedCandidates[0], '/Applications/Natively.app/Contents/XPCServices/macos-full-stealth-helper.xpc/Contents/MacOS/macos-full-stealth-helper');
});

test('resolveMacosVirtualDisplayHelperPath prefers explicit env override', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: { NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER: '/tmp/helper' },
    pathExists: () => true,
    cwd: '/workspace',
  });

  assert.equal(resolved, '/tmp/helper');
});

test('resolveMacosVirtualDisplayHelperPath returns null when helper resolution is explicitly disabled', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {
      NATIVELY_DISABLE_MACOS_VIRTUAL_DISPLAY_HELPER: 'true',
      NATIVELY_MACOS_VIRTUAL_DISPLAY_HELPER: '/tmp/helper',
    },
    cwd: '/workspace',
    resourcesPath: '/app/resources',
    pathExists: () => true,
  });

  assert.equal(resolved, null);
});

test('resolveMacosVirtualDisplayHelperPath falls back to the local Swift build output', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    pathExists: (candidate) => candidate.endsWith('/stealth-projects/macos-virtual-display-helper/.build/debug/stealth-virtual-display-helper'),
  });

  assert.match(resolved ?? '', /stealth-virtual-display-helper$/);
});

test('resolveMacosVirtualDisplayHelperPath returns null when no candidates exist', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    pathExists: () => false,
  });

  assert.equal(resolved, null);
});

test('createMacosVirtualDisplayCoordinator returns a coordinator with the given helper path', () => {
  const coordinator = createMacosVirtualDisplayCoordinator('/usr/local/bin/helper');
  assert.ok(coordinator);
});

test('resolveMacosVirtualDisplayHelperPath uses resourcesPath when provided', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    resourcesPath: '/app/resources',
    pathExists: (candidate) => candidate === '/app/resources/bin/macos/stealth-virtual-display-helper',
  });

  assert.equal(resolved, '/app/resources/bin/macos/stealth-virtual-display-helper');
});

test('resolveMacosVirtualDisplayHelperPath falls through env check when env var is missing', () => {
  const resolved = resolveMacosVirtualDisplayHelperPath({
    env: {},
    cwd: '/workspace',
    pathExists: (candidate) => candidate.endsWith('.build/debug/stealth-virtual-display-helper'),
  });

  assert.match(resolved ?? '', /stealth-virtual-display-helper$/);
});

test('MacosVirtualDisplayCoordinator dispose releases active sessions and disposes client', async () => {
  const released: string[] = [];
  let clientDisposed = false;
  const mockClient = {
    createSession: () => Promise.resolve({ ready: true, sessionId: 's1', mode: 'virtual-display' as const }),
    releaseSession: (sessionId: string) => { released.push(sessionId); return Promise.resolve(); },
    dispose: () => { clientDisposed = true; },
    isExhausted: () => false,
  } as unknown as MacosVirtualDisplayClient;

  const coordinator = new MacosVirtualDisplayCoordinator(mockClient);
  await coordinator.ensureIsolationForWindow({ sessionId: 's1', windowId: 'w1', width: 1280, height: 720 });

  coordinator.dispose();

  assert.ok(released.includes('s1'));
  assert.equal(clientDisposed, true);
});
