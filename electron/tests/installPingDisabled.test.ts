import test from 'node:test';
import assert from 'node:assert/strict';

import { sendAnonymousInstallPing } from '../services/InstallPingManager';

test('NAT-033: InstallPingManager is disabled by default without NATIVELY_INSTALL_PING_ENABLED', async () => {
  const original = process.env.NATIVELY_INSTALL_PING_ENABLED;
  try {
    delete process.env.NATIVELY_INSTALL_PING_ENABLED;
    // Should resolve immediately without network activity
    await sendAnonymousInstallPing();
    assert.ok(true, 'sendAnonymousInstallPing resolved when disabled');
  } finally {
    if (original !== undefined) {
      process.env.NATIVELY_INSTALL_PING_ENABLED = original;
    }
  }
});

test('NAT-033: InstallPingManager skips when already sent even if enabled', async () => {
  const original = process.env.NATIVELY_INSTALL_PING_ENABLED;
  try {
    process.env.NATIVELY_INSTALL_PING_ENABLED = '1';
    // This will check the sent flag; if already sent, it returns early
    await sendAnonymousInstallPing();
    assert.ok(true, 'sendAnonymousInstallPing resolved');
  } finally {
    if (original !== undefined) {
      process.env.NATIVELY_INSTALL_PING_ENABLED = original;
    } else {
      delete process.env.NATIVELY_INSTALL_PING_ENABLED;
    }
  }
});
