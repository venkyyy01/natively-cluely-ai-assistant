import test from 'node:test';
import assert from 'node:assert/strict';

import { MacosVirtualDisplayClient } from '../stealth/MacosVirtualDisplayClient';

test('NAT-032: client generates a nonce on construction', () => {
  const client = new MacosVirtualDisplayClient({ helperPath: '/tmp/helper' });
  const nonce = (client as any).nonce as string;
  assert.ok(typeof nonce === 'string');
  assert.ok(nonce.length > 0);
  // UUID v4 pattern
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce));
});

test('NAT-032: signature verification fails for unsigned helper on darwin', async () => {
  if (process.platform !== 'darwin') {
    // Skip on non-darwin platforms because verification is platform-gated
    return;
  }

  const client = new MacosVirtualDisplayClient({
    helperPath: '/nonexistent/helper',
    skipSignatureVerification: false,
  });

  let emitted = false;
  client.on('stealth:helper_signature_failed', () => {
    emitted = true;
  });

  try {
    await (client as any).ensureServerProcess();
    assert.fail('Expected signature verification to throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok((error as Error).message.includes('signature verification failed'));
    assert.equal(emitted, true);
  }
});

test('NAT-032: skipSignatureVerification bypasses check on darwin', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const client = new MacosVirtualDisplayClient({
    helperPath: '/nonexistent/helper',
    skipSignatureVerification: true,
  });

  let emitted = false;
  client.on('stealth:helper_signature_failed', () => {
    emitted = true;
  });

  // It should proceed past signature check and fail at spawn instead
  try {
    await (client as any).ensureServerProcess();
    assert.fail('Expected spawn to throw');
  } catch (error) {
    assert.ok(error instanceof Error);
    // Should NOT be signature error
    assert.ok(!(error as Error).message.includes('signature verification failed'));
    assert.equal(emitted, false);
  }
});

test('NAT-032: flushServerResponses drops response with wrong nonce', () => {
  const client = new MacosVirtualDisplayClient({ helperPath: '/tmp/helper' });
  const correctNonce = (client as any).nonce as string;
  const wrongNonce = '00000000-0000-0000-0000-000000000000';
  assert.notEqual(correctNonce, wrongNonce);

  let resolved = false;
  let rejected = false;

  const pending = {
    resolve: () => {
      resolved = true;
    },
    reject: () => {
      rejected = true;
    },
    timeout: setTimeout(() => {}, 99999),
  };

  (client as any).pending.set('req-1', pending);
  (client as any).stdoutBuffer =
    JSON.stringify({ id: 'req-1', ok: true, result: {}, nonce: wrongNonce }) + '\n';
  (client as any).flushServerResponses();

  assert.equal(resolved, false);
  assert.equal(rejected, false);
  assert.equal((client as any).pending.has('req-1'), true);

  clearTimeout(pending.timeout);
});

test('NAT-032: flushServerResponses resolves response with matching nonce', () => {
  const client = new MacosVirtualDisplayClient({ helperPath: '/tmp/helper' });
  const correctNonce = (client as any).nonce as string;

  let resolved = false;
  let rejected = false;

  const pending = {
    resolve: () => {
      resolved = true;
    },
    reject: () => {
      rejected = true;
    },
    timeout: setTimeout(() => {}, 99999),
  };

  (client as any).pending.set('req-1', pending);
  (client as any).stdoutBuffer =
    JSON.stringify({ id: 'req-1', ok: true, result: { ready: true }, nonce: correctNonce }) + '\n';
  (client as any).flushServerResponses();

  assert.equal(resolved, true);
  assert.equal(rejected, false);
  assert.equal((client as any).pending.has('req-1'), false);

  clearTimeout(pending.timeout);
});

test('NAT-032: flushServerResponses allows backward-compatible responses without nonce', () => {
  const client = new MacosVirtualDisplayClient({ helperPath: '/tmp/helper' });

  let resolved = false;
  let rejected = false;

  const pending = {
    resolve: () => {
      resolved = true;
    },
    reject: () => {
      rejected = true;
    },
    timeout: setTimeout(() => {}, 99999),
  };

  (client as any).pending.set('req-1', pending);
  (client as any).stdoutBuffer =
    JSON.stringify({ id: 'req-1', ok: true, result: { ready: true } }) + '\n';
  (client as any).flushServerResponses();

  assert.equal(resolved, true);
  assert.equal(rejected, false);
  assert.equal((client as any).pending.has('req-1'), false);

  clearTimeout(pending.timeout);
});
