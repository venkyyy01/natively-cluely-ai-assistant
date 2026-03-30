import test from 'node:test';
import assert from 'node:assert/strict';

import { MacosVirtualDisplayClient } from '../stealth/MacosVirtualDisplayClient';

test('MacosVirtualDisplayClient parses helper status output', async () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    runHelper: async ({ command }: { command: 'status' | 'create-session' | 'release-session'; stdin?: string }) => {
      assert.equal(command, 'status');
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ready: true, component: 'macos-virtual-display-helper' }),
        stderr: '',
      };
    },
  });

  const status = await client.getStatus();
  assert.equal(status.ready, true);
  assert.equal(status.component, 'macos-virtual-display-helper');
});

test('MacosVirtualDisplayClient sends create-session payloads and returns parsed session results', async () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    runHelper: async ({ command, stdin }: { command: 'status' | 'create-session' | 'release-session'; stdin?: string }) => {
      assert.equal(command, 'create-session');
      const payload = JSON.parse(stdin ?? '{}');
      assert.equal(payload.sessionId, 'session-1');
      assert.equal(payload.windowId, 'window-1');
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ready: true, sessionId: 'session-1', surfaceToken: 'surface-1' }),
        stderr: '',
      };
    },
  });

  const response = await client.createSession({
    sessionId: 'session-1',
    windowId: 'window-1',
    width: 1440,
    height: 900,
  });

  assert.equal(response.ready, true);
  assert.equal(response.surfaceToken, 'surface-1');
});

test('MacosVirtualDisplayClient returns structured helper failures', async () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    runHelper: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
    }),
  });

  await assert.rejects(() => client.getStatus(), /boom/);
});
