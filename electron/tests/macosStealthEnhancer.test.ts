import test from 'node:test';
import assert from 'node:assert/strict';

import { MacosStealthEnhancer } from '../stealth/MacosStealthEnhancer';

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

test('MacosStealthEnhancer runs python with a raw script argument', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const enhancer = new MacosStealthEnhancer({
    platform: 'darwin',
    logger: silentLogger,
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return '';
    },
  });

  const applied = await enhancer.enhanceWindowProtection(101);

  assert.equal(applied, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'python3');
    assert.deepEqual(call.args[0], '-c');
    assert.match(call.args[1] ?? '', /window_number = 101/);
    assert.equal(call.args[1]?.startsWith("'"), false);
    assert.equal(call.args[1]?.endsWith("'"), false);
  }
});

test('MacosStealthEnhancer rejects invalid window numbers before spawning python', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const enhancer = new MacosStealthEnhancer({
    platform: 'darwin',
    logger: silentLogger,
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      return '';
    },
  });

  const applied = await enhancer.enhanceWindowProtection(Number.NaN);

  assert.equal(applied, false);
  assert.deepEqual(calls, []);
});
