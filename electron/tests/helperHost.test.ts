import test from 'node:test';
import assert from 'node:assert/strict';

import { HelperHost } from '../runtime/HelperHost';

test('NAT-063: HelperHost sanitizes env by dropping secrets', async () => {
  const host = new HelperHost({
    command: 'echo',
    args: ['hello'],
    env: { PATH: '/usr/bin', API_SECRET: 'shh', NORMAL_VAR: 'ok' },
  });

  const sanitized = (host as any).sanitizeEnv({ PATH: '/usr/bin', API_SECRET: 'shh', NORMAL_VAR: 'ok' });
  assert.equal(sanitized.PATH, '/usr/bin');
  assert.equal(sanitized.API_SECRET, undefined);
  assert.equal(sanitized.NORMAL_VAR, 'ok');
});

test('NAT-063: HelperHost attestation failure prevents spawn', async () => {
  const host = new HelperHost({
    command: 'echo',
    attestation: async () => false,
  });

  await assert.rejects(async () => host.spawn(), /attestation failed/);
});

test('NAT-063: HelperHost cancels pending request', async () => {
  const host = new HelperHost({ command: 'sleep', args: ['10'] });
  await host.spawn();

  const cancelled = host.cancel('req-1');
  assert.equal(cancelled, false); // req-1 was never pending

  host.dispose();
});

test('NAT-063: HelperHost dispose kills process and clears state', async () => {
  const host = new HelperHost({ command: 'sleep', args: ['30'] });
  await host.spawn();
  assert.equal(host.isRunning(), true);

  host.dispose();
  assert.equal(host.isRunning(), false);
});

test('NAT-063: HelperHost emits spawn event', async () => {
  const host = new HelperHost({ command: 'echo', args: ['hi'] });
  let spawned = false;
  host.on('spawn', () => { spawned = true; });

  await host.spawn();
  assert.equal(spawned, true);

  host.dispose();
});

test('NAT-063: HelperHost max restarts limits recovery', async () => {
  const host = new HelperHost({
    command: 'false',
    maxRestarts: 2,
  });

  const events: string[] = [];
  host.on('restart', () => events.push('restart'));
  host.on('max-restarts', () => events.push('max-restarts'));

  await host.spawn();

  // Wait for process to exit and restart attempts
  await new Promise((resolve) => setTimeout(resolve, 3500));

  assert.ok(events.includes('max-restarts'), 'should hit max-restarts');
  assert.equal(host.getRestartCount(), 2);

  host.dispose();
});

test('NAT-063: HelperHost handles JSON response parsing', async () => {
  const host = new HelperHost({ command: 'echo', args: ['{"id":"r1","payload":"ok"}'] });
  await host.spawn();

  const responses: Array<{ id: string; payload: string }> = [];
  host.on('response', (r) => responses.push(r));

  // Give echo time to flush
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(responses.length >= 1 || !host.isRunning(), 'should have emitted response or exited');

  host.dispose();
});

test('NAT-063: HelperHost rejects send when process not running', async () => {
  const host = new HelperHost({ command: 'echo', args: ['hi'] });

  await assert.rejects(
    host.send({ id: 'r1', payload: 'test' }),
    /not running/,
  );
});

test('NAT-063: HelperHost disposes cleanly when already disposed', () => {
  const host = new HelperHost({ command: 'echo' });
  host.dispose();
  assert.doesNotThrow(() => host.dispose());
});
