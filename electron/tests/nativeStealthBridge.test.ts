import test from 'node:test';
import assert from 'node:assert/strict';

import { NativeStealthBridge } from '../stealth/NativeStealthBridge';

test('NativeStealthBridge gracefully degrades when helper is unavailable', async () => {
  const bridge = new NativeStealthBridge({
    helperPathResolver: () => null,
  });

  assert.equal(bridge.isConnected(), false);

  const arm = await bridge.arm();
  assert.deepEqual(arm, {
    connected: false,
    sessionId: null,
    surfaceId: null,
  });

  const heartbeat = await bridge.heartbeat();
  assert.deepEqual(heartbeat, {
    connected: false,
    healthy: false,
  });
});

test('NativeStealthBridge arms session and verifies healthy heartbeat', async () => {
  const calls: string[] = [];
  const bridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-1',
    clientFactory: () => ({
      async createProtectedSession(request) {
        calls.push(`create:${request.sessionId}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: 'creating',
          },
        };
      },
      async attachSurface(request) {
        calls.push(`attach:${request.surfaceId}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: 'attached',
            surfaceAttached: true,
            presenting: false,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async present(request) {
        calls.push(`present:${request.activate}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: request.activate ? 'presenting' : 'attached',
            surfaceAttached: true,
            presenting: request.activate,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async getHealth(sessionId) {
        calls.push(`health:${sessionId}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId,
            state: 'presenting',
            surfaceAttached: true,
            presenting: true,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async teardownSession(sessionId) {
        calls.push(`teardown:${sessionId}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: false,
          blockers: [],
          data: { released: true },
        };
      },
      dispose() {},
    }),
  });

  const arm = await bridge.arm({ width: 1920, height: 1080 });
  assert.equal(arm.connected, true);
  assert.equal(arm.sessionId, 'session-1');
  assert.equal(arm.surfaceId, 'surface-session-1');
  assert.equal(bridge.getActiveSessionId(), 'session-1');

  const heartbeat = await bridge.heartbeat();
  assert.deepEqual(heartbeat, { connected: true, healthy: true });

  const frameResult = await bridge.submitFrame('surface-session-1', {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });
  assert.deepEqual(frameResult, { connected: true, accepted: true });

  await bridge.fault('test');
  assert.equal(bridge.getActiveSessionId(), null);

  assert.deepEqual(calls, [
    'create:session-1',
    'attach:surface-session-1',
    'present:true',
    'health:session-1',
    'health:session-1',
    'present:false',
    'teardown:session-1',
  ]);
});

test('NativeStealthBridge reports unhealthy heartbeat and reject invalid frame submissions', async () => {
  const bridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-2',
    clientFactory: () => ({
      async createProtectedSession(request) {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: { sessionId: request.sessionId, state: 'creating' },
        };
      },
      async attachSurface(request) {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: 'attached',
            surfaceAttached: true,
            presenting: false,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async present(request) {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: 'presenting',
            surfaceAttached: true,
            presenting: true,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async getHealth(sessionId) {
        return {
          outcome: 'degraded',
          failClosed: true,
          presentationAllowed: false,
          blockers: [{ code: 'surface-not-attached', message: 'missing', retryable: true }],
          data: {
            sessionId,
            state: 'failed',
            surfaceAttached: false,
            presenting: false,
            recoveryPending: true,
            blockers: [{ code: 'surface-not-attached', message: 'missing', retryable: true }],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async teardownSession() {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: false,
          blockers: [],
          data: { released: true },
        };
      },
      dispose() {},
    }),
  });

  await bridge.arm();

  const invalidSurface = await bridge.submitFrame('wrong-surface', {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  });
  assert.deepEqual(invalidSurface, { connected: true, accepted: false });

  const invalidRegion = await bridge.submitFrame('surface-session-2', {
    x: 0,
    y: 0,
    width: 0,
    height: 10,
  });
  assert.deepEqual(invalidRegion, { connected: true, accepted: false });

  const heartbeat = await bridge.heartbeat();
  assert.deepEqual(heartbeat, { connected: true, healthy: false });
});

test('NativeStealthBridge fails arm when helper control-plane is blocked', async () => {
  const bridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-3',
    clientFactory: () => ({
      async createProtectedSession() {
        return {
          outcome: 'blocked',
          failClosed: true,
          presentationAllowed: false,
          blockers: [{ code: 'physical-display-mechanism-unproven', message: 'blocked', retryable: false }],
          data: { sessionId: 'session-3', state: 'blocked' },
        };
      },
      async attachSurface() {
        throw new Error('unreachable');
      },
      async present() {
        throw new Error('unreachable');
      },
      async getHealth() {
        throw new Error('unreachable');
      },
      async teardownSession() {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: false,
          blockers: [],
          data: { released: true },
        };
      },
      dispose() {},
    }),
  });

  await assert.rejects(() => bridge.arm(), /create-protected-session failed/);
  assert.equal(bridge.getActiveSessionId(), null);
});

test('NativeStealthBridge attempts one restart after helper disconnect and emits disconnect event', async () => {
  const calls: string[] = [];
  const disconnects: string[] = [];
  let healthCalls = 0;

  const bridge = new NativeStealthBridge({
    helperPathResolver: () => '/tmp/helper',
    sessionIdFactory: () => 'session-restart',
    onHelperDisconnect: (reason) => {
      disconnects.push(reason);
    },
    clientFactory: () => ({
      async createProtectedSession(request) {
        calls.push(`create:${request.sessionId}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: { sessionId: request.sessionId, state: 'creating' },
        };
      },
      async attachSurface(request) {
        calls.push(`attach:${request.surfaceId}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: 'attached',
            surfaceAttached: true,
            presenting: false,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async present(request) {
        calls.push(`present:${request.activate}`);
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId: request.sessionId,
            state: request.activate ? 'presenting' : 'attached',
            surfaceAttached: true,
            presenting: request.activate,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async getHealth(sessionId) {
        healthCalls += 1;
        calls.push(`health:${sessionId}:${healthCalls}`);
        if (healthCalls === 1) {
          throw new Error('helper-exit');
        }

        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: true,
          blockers: [],
          data: {
            sessionId,
            state: 'presenting',
            surfaceAttached: true,
            presenting: true,
            recoveryPending: false,
            blockers: [],
            lastTransitionAt: new Date(0).toISOString(),
          },
        };
      },
      async teardownSession() {
        return {
          outcome: 'ok',
          failClosed: false,
          presentationAllowed: false,
          blockers: [],
          data: { released: true },
        };
      },
      dispose() {},
    }),
  });

  await bridge.arm();
  const heartbeat = await bridge.heartbeat();

  assert.deepEqual(heartbeat, { connected: true, healthy: true });
  assert.equal(bridge.getActiveSessionId(), 'session-restart');
  assert.equal(disconnects.length, 1);
  assert.match(disconnects[0] ?? '', /heartbeat:helper-exit/);
  assert.ok(calls.filter((call) => call === 'create:session-restart').length >= 2);
});
