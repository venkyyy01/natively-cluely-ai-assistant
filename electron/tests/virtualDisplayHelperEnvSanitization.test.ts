import test from 'node:test';
import assert from 'node:assert/strict';

import { MacosVirtualDisplayClient } from '../stealth/MacosVirtualDisplayClient';

test('NAT-031: helperEnv is sanitized to PATH, HOME, TMPDIR only', () => {
  const client = new MacosVirtualDisplayClient({
    helperPath: '/tmp/helper',
    helperEnv: {
      PATH: '/usr/bin',
      HOME: '/home/user',
      TMPDIR: '/tmp',
      OPENAI_API_KEY: 'sk-secret',
      NATIVELY_SECRET: 'should-not-appear',
    },
  });

  const env = (client as any).helperEnv as NodeJS.ProcessEnv;
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/user');
  assert.equal(env.TMPDIR, '/tmp');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NATIVELY_SECRET, undefined);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'TMPDIR']);
});

test('NAT-031: default env falls back to sanitized process.env', () => {
  const originalEnv = process.env;
  (process as any).env = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    TMPDIR: '/tmp',
    SECRET: 'hidden',
  };

  try {
    const client = new MacosVirtualDisplayClient({
      helperPath: '/tmp/helper',
    });

    const env = (client as any).helperEnv as NodeJS.ProcessEnv;
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/user');
    assert.equal(env.TMPDIR, '/tmp');
    assert.equal(env.SECRET, undefined);
  } finally {
    (process as any).env = originalEnv;
  }
});

test('NAT-031: isExhausted emits stealth:helper_dead when respawn limit exceeded', () => {
  const client = new MacosVirtualDisplayClient({ helperPath: '/tmp/helper' });
  let emitted = false;
  client.on('stealth:helper_dead', () => {
    emitted = true;
  });

  const internal = client as unknown as { respawnTimestamps: number[] };
  const now = Date.now();
  internal.respawnTimestamps = [now - 1_000, now - 2_000, now - 3_000];

  assert.equal(client.isExhausted(), true);
  assert.equal(emitted, true);
});

test('NAT-031: isExhausted does not emit when below respawn limit', () => {
  const client = new MacosVirtualDisplayClient({ helperPath: '/tmp/helper' });
  let emitted = false;
  client.on('stealth:helper_dead', () => {
    emitted = true;
  });

  const internal = client as unknown as { respawnTimestamps: number[] };
  const now = Date.now();
  internal.respawnTimestamps = [now - 2_000];

  assert.equal(client.isExhausted(), false);
  assert.equal(emitted, false);
});
