import test from 'node:test';
import assert from 'node:assert/strict';

import { MacosStealthEnhancer } from '../stealth/MacosStealthEnhancer';

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

test('MacosStealthEnhancer applies level and sharing protection through native bindings', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const nativeCalls: string[] = [];
  const enhancer = new MacosStealthEnhancer({
    platform: 'darwin',
    logger: silentLogger,
    nativeModule: {
      setMacosWindowLevel: (windowNumber, level) => nativeCalls.push(`level:${windowNumber}:${level}`),
      applyMacosWindowStealth: (windowNumber) => nativeCalls.push(`apply:${windowNumber}`),
    },
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return '';
    },
  });

  const applied = await enhancer.enhanceWindowProtection(101);

  assert.equal(applied, true);
  assert.deepEqual(nativeCalls, ['level:101:19', 'apply:101']);
  assert.deepEqual(calls, []);
});

test('MacosStealthEnhancer removes sharing protection through native bindings', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const nativeCalls: string[] = [];
  const enhancer = new MacosStealthEnhancer({
    platform: 'darwin',
    logger: silentLogger,
    nativeModule: {
      removeMacosWindowStealth: (windowNumber) => nativeCalls.push(`remove:${windowNumber}`),
    },
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return '';
    },
  });

  await enhancer.removeEnhancedProtection(202);

  assert.deepEqual(nativeCalls, ['remove:202']);
  assert.deepEqual(calls, []);
});

test('MacosStealthEnhancer rejects invalid window numbers before native calls', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const enhancer = new MacosStealthEnhancer({
    platform: 'darwin',
    logger: silentLogger,
    nativeModule: {
      setMacosWindowLevel: () => {
        throw new Error('should not be called');
      },
      applyMacosWindowStealth: () => {
        throw new Error('should not be called');
      },
    },
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return '';
    },
  });

  const applied = await enhancer.enhanceWindowProtection(Number.NaN);

  assert.equal(applied, false);
  assert.deepEqual(calls, []);
});

test('MacosStealthEnhancer blocks python fallback in strict production mode', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousStrict = process.env.NATIVELY_STRICT_PROTECTION;
  process.env.NODE_ENV = 'production';
  process.env.NATIVELY_STRICT_PROTECTION = '1';

  try {
    const calls: Array<{ command: string; args: string[] }> = [];
    const enhancer = new MacosStealthEnhancer({
      platform: 'darwin',
      logger: silentLogger,
      nativeModule: null,
      commandRunner: async (command, args) => {
        calls.push({ command, args });
        return '';
      },
    });

    const applied = await enhancer.enhanceWindowProtection(303);

    assert.equal(applied, false);
    assert.deepEqual(calls, []);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousStrict === undefined) {
      delete process.env.NATIVELY_STRICT_PROTECTION;
    } else {
      process.env.NATIVELY_STRICT_PROTECTION = previousStrict;
    }
  }
});
