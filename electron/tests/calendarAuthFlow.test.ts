import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import http from 'node:http';

type OpenExternalCall = { url: string };
type AxiosPostCall = { url: string; payload: Record<string, unknown> };

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: '',
    end(message?: string) {
      this.body = message || '';
    },
  };
}

async function loadCalendarManagerHarness() {
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const originalRequire = Module.prototype.require;
  const originalCreateServer = http.createServer;

  process.env.GOOGLE_CLIENT_ID = 'calendar-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'calendar-client-secret';

  let requestHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) | null = null;
  let closeCalls = 0;
  const openExternalCalls: OpenExternalCall[] = [];
  const axiosPostCalls: AxiosPostCall[] = [];

  const stubServer = {
    on() {
      return stubServer;
    },
    listen(port: number, host: string, callback?: () => void) {
      assert.equal(port, 0);
      assert.equal(host, '127.0.0.1');
      callback?.();
      return stubServer;
    },
    address() {
      return { address: '127.0.0.1', family: 'IPv4', port: 4242 };
    },
    close(callback?: () => void) {
      closeCalls += 1;
      callback?.();
      return stubServer;
    },
  } as unknown as http.Server;

  http.createServer = ((handler: typeof requestHandler) => {
    requestHandler = handler;
    return stubServer;
  }) as typeof http.createServer;

  Module.prototype.require = function patchedRequire(this: unknown, id: string) {
    if (id === 'electron') {
      return {
        app: {
          getPath: () => '/tmp',
        },
        safeStorage: {
          isEncryptionAvailable: () => false,
        },
        shell: {
          openExternal: async (url: string) => {
            openExternalCalls.push({ url });
          },
        },
        net: {},
      };
    }

    if (id === 'axios') {
      return {
        post: async (url: string, payload: Record<string, unknown>) => {
          axiosPostCalls.push({ url, payload });
          return {
            data: {
              access_token: 'token',
              refresh_token: 'refresh',
              expires_in: 3600,
            },
          };
        },
        get: async () => ({ data: { items: [] as unknown[] } }),
      };
    }

    return originalRequire.call(this, id);
  };

  const modulePath = require.resolve('../services/CalendarManager');
  delete require.cache[modulePath];

  try {
    const { CalendarManager } = require('../services/CalendarManager');
    const manager = CalendarManager.getInstance();
    return {
      manager,
      axiosPostCalls,
      openExternalCalls,
      getRequestHandler: () => requestHandler,
      getCloseCalls: () => closeCalls,
      restore() {
        delete require.cache[modulePath];
        Module.prototype.require = originalRequire;
        http.createServer = originalCreateServer;
        if (originalClientId === undefined) {
          delete process.env.GOOGLE_CLIENT_ID;
        } else {
          process.env.GOOGLE_CLIENT_ID = originalClientId;
        }
        if (originalClientSecret === undefined) {
          delete process.env.GOOGLE_CLIENT_SECRET;
        } else {
          process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
        }
      },
    };
  } catch (error) {
    Module.prototype.require = originalRequire;
    http.createServer = originalCreateServer;
    if (originalClientId === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
      delete process.env.GOOGLE_CLIENT_SECRET;
    } else {
      process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
    }
    throw error;
  }
}

test('startAuthFlow binds a single-use loopback listener and exchanges against the bound redirect URI', async () => {
  const harness = await loadCalendarManagerHarness();

  try {
    const authPromise = harness.manager.startAuthFlow();
    assert.equal(harness.openExternalCalls.length, 1);

    const authUrl = new URL(harness.openExternalCalls[0].url);
    const redirectUri = authUrl.searchParams.get('redirect_uri');
    const state = authUrl.searchParams.get('state');

    assert.equal(redirectUri, 'http://127.0.0.1:4242/auth/callback');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(state);

    const handler = harness.getRequestHandler();
    assert.ok(handler);

    const response = createResponseRecorder();
    await handler!({
      method: 'GET',
      url: `/auth/callback?code=auth-code&state=${state}`,
      socket: { remoteAddress: '127.0.0.1' },
    } as http.IncomingMessage, response as unknown as http.ServerResponse);

    await authPromise;

    assert.match(response.body, /Authentication successful/i);
    assert.equal(harness.axiosPostCalls.length, 1);
    assert.equal(harness.axiosPostCalls[0].payload.redirect_uri, 'http://127.0.0.1:4242/auth/callback');
    assert.equal(harness.getCloseCalls(), 1);
  } finally {
    harness.restore();
  }
});

test('startAuthFlow rejects callbacks with the wrong state and tears down the listener', async () => {
  const harness = await loadCalendarManagerHarness();

  try {
    const authPromise = harness.manager.startAuthFlow();
    assert.equal(harness.openExternalCalls.length, 1);

    const handler = harness.getRequestHandler();
    assert.ok(handler);

    const response = createResponseRecorder();
    await handler!({
      method: 'GET',
      url: '/auth/callback?code=auth-code&state=wrong-state',
      socket: { remoteAddress: '127.0.0.1' },
    } as http.IncomingMessage, response as unknown as http.ServerResponse);

    await assert.rejects(authPromise, /OAuth state mismatch/);
    assert.match(response.body, /invalid session state/i);
    assert.equal(harness.axiosPostCalls.length, 0);
    assert.equal(harness.getCloseCalls(), 1);
  } finally {
    harness.restore();
  }
});
