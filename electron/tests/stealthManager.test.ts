import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StealthManager, StealthConfig } from '../stealth/StealthManager';

describe('StealthManager', () => {
  it('should generate correct BrowserWindow options when enabled', () => {
    const config: StealthConfig = { enabled: true };
    const manager = new StealthManager(config);
    const opts = manager.getBrowserWindowOptions();

    assert.strictEqual(opts.contentProtection, true);
    assert.strictEqual(opts.skipTaskbar, true);
  });

  it('should return default options when disabled (toggle OFF)', () => {
    const config: StealthConfig = { enabled: false };
    const manager = new StealthManager(config);
    const opts = manager.getBrowserWindowOptions();

    assert.strictEqual(opts.contentProtection, false);
  });

  it('should detect platform capabilities', () => {
    const config: StealthConfig = { enabled: true };
    const manager = new StealthManager(config);
    const caps = manager.getPlatformCapabilities();

    assert(typeof caps.supportsContentProtection === 'boolean');
    assert(typeof caps.platform === 'string');
  });
});
