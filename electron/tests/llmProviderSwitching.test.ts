import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

async function loadLLMHelper() {
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function patchedRequire(this: unknown, id: string) {
    if (id === 'electron') {
      return {
        app: {
          getPath: () => '/tmp',
          isPackaged: false,
        },
      };
    }
    return originalRequire.call(this, id);
  };

  try {
    return (await import('../LLMHelper')).LLMHelper;
  } finally {
    Module.prototype.require = originalRequire;
  }
}

test('switching from cURL provider back to cloud model clears stale cURL routing state', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('curl-provider', [{ id: 'curl-provider', name: 'cURL', curlCommand: 'curl https://example.com' }]);
  assert.equal(helper.getProviderCapabilityClass(), 'non_streaming');

  helper.setModel('gemini', []);

  assert.notEqual(helper.getProviderCapabilityClass(), 'non_streaming');
  assert.notEqual(helper.getCurrentModel(), 'curl-provider');
  helper.scrubKeys();
});
