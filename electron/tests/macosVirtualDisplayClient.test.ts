import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

test('MacosVirtualDisplayClient parses probe-capabilities output', async () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    runHelper: async ({ command }: { command: 'status' | 'create-session' | 'release-session' | 'probe-capabilities' | 'create-protected-session' | 'attach-surface' | 'present' | 'teardown-session' | 'get-health' | 'get-telemetry'; stdin?: string }) => {
      assert.equal(command, 'probe-capabilities');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          outcome: 'blocked',
          failClosed: false,
          presentationAllowed: false,
          blockers: [{ code: 'physical-display-mechanism-unproven', message: 'unproven', retryable: false }],
          data: {
            platform: 'darwin',
            osVersion: '14.4.0',
            nativePresenterAvailable: true,
            cgVirtualDisplayAvailable: true,
            screenRecordingPermission: 'not-granted',
            candidatePhysicalDisplayMechanismProven: false,
            blockers: [{ code: 'physical-display-mechanism-unproven', message: 'unproven', retryable: false }],
          },
        }),
        stderr: '',
      };
    },
  });

  const response = await client.probeCapabilities();
  assert.equal(response.outcome, 'blocked');
  assert.equal(response.data.platform, 'darwin');
  assert.equal(response.data.candidatePhysicalDisplayMechanismProven, false);
});

test('MacosVirtualDisplayClient sends present payloads and parses health envelope', async () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    runHelper: async ({ command, stdin }: { command: 'status' | 'create-session' | 'release-session' | 'probe-capabilities' | 'create-protected-session' | 'attach-surface' | 'present' | 'teardown-session' | 'get-health' | 'get-telemetry'; stdin?: string }) => {
      assert.equal(command, 'present');
      const payload = JSON.parse(stdin ?? '{}');
      assert.equal(payload.sessionId, 'session-9');
      assert.equal(payload.activate, true);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: 'session-9',
            state: 'presenting',
            surfaceAttached: true,
            presenting: true,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: '2026-03-30T12:00:00Z',
          },
        }),
        stderr: '',
      };
    },
  });

  const response = await client.present({ sessionId: 'session-9', activate: true });
  assert.equal(response.outcome, 'ok');
  assert.equal(response.data.state, 'presenting');
  assert.equal(response.data.presenting, true);
});

test('MacosVirtualDisplayClient parses validate-session output', async () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    runHelper: async ({ command }: { command: 'status' | 'create-session' | 'release-session' | 'probe-capabilities' | 'create-protected-session' | 'attach-surface' | 'present' | 'teardown-session' | 'get-health' | 'get-telemetry' | 'validate-session'; stdin?: string }) => {
      assert.equal(command, 'validate-session');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: false,
          blockers: [],
          data: {
            sessionId: 'session-v',
            status: 'failed',
            reason: 'Presenter window is visible via CGWindowList enumeration',
            windowEnumerated: true,
            matchedWindowNumber: true,
            matchedWindowTitle: true,
            screenCaptureKitEnumerated: false,
            matchedShareableContentWindow: false,
          },
        }),
        stderr: '',
      };
    },
  });

  const response = await client.validateSession('session-v');
  assert.equal(response.outcome, 'ok');
  assert.equal(response.data.status, 'failed');
  assert.equal(response.data.windowEnumerated, true);
});

test('MacosVirtualDisplayClient rejects pending requests on malformed helper JSON', async () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    runHelper: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }),
  });

  let killed = false;
  const internal = client as unknown as {
    pending: Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>;
    stdoutBuffer: string;
    serverProcess: { kill: () => void } | null;
    flushServerResponses: () => void;
  };

  const rejection = new Promise<string>((resolve) => {
    internal.pending.set('req-1', {
      resolve: () => {
        throw new Error('expected rejection');
      },
      reject: (error) => resolve(error.message),
      timeout: setTimeout(() => undefined, 1000),
    });
  });

  internal.serverProcess = { kill: () => { killed = true; } };
  internal.stdoutBuffer = 'not-json\n';
  internal.flushServerResponses();

  assert.match(await rejection, /Invalid helper JSON response/);
  assert.equal(internal.pending.size, 0);
  assert.equal(killed, true);
});

test('MacosVirtualDisplayClient serve mode works against the built helper when available', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS-only helper integration test');
    return;
  }

  const helperPath = path.join(process.cwd(), 'stealth-projects/macos-virtual-display-helper/.build/debug/stealth-virtual-display-helper');
  if (!fs.existsSync(helperPath)) {
    t.skip('built helper not available');
    return;
  }

  const client = new MacosVirtualDisplayClient({ helperPath });
  try {
    const probe = await client.probeCapabilities();
    assert.equal(typeof probe.outcome, 'string');

    const create = await client.createProtectedSession({
      sessionId: 'serve-e2e',
      presentationMode: 'native-fullscreen-presenter',
      displayPreference: 'dedicated-display',
      reason: 'validation-run',
    });
    assert.equal(typeof create.outcome, 'string');
  } finally {
    client.dispose();
  }
});
