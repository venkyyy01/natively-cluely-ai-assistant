import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { StealthManager, StealthConfig } from '../stealth/StealthManager';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';

describe('StealthManager', () => {
  beforeEach(() => {
    setOptimizationFlags({ accelerationEnabled: true, useStealthMode: true });
  });

  afterEach(() => {
    setOptimizationFlags({ accelerationEnabled: false, useStealthMode: true });
  });

  it('should generate correct BrowserWindow options when enabled', () => {
    const config: StealthConfig = { enabled: true };
    const manager = new StealthManager(config);
    const opts = manager.getBrowserWindowOptions();

    assert.strictEqual(opts.contentProtection, true);
    assert.strictEqual(opts.skipTaskbar, true);
  });

  it('should return default options when disabled (toggle OFF)', () => {
    setOptimizationFlags({ accelerationEnabled: false });
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
