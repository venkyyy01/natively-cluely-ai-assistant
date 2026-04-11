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

test('chatWithCurl treats null responsePath extraction as a failure instead of returning "null"', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com',
    responsePath: 'choices[0].message.content',
  }]);

  const LLMHelperCtor = helper.__proto__.constructor;
  const originalAxios = LLMHelperCtor.__testAxios;
  LLMHelperCtor.__testAxios = async () => ({ data: { choices: [{ message: { content: null as string | null } }] } });

  try {
    await assert.rejects(
      () => helper.chatWithCurl('hello'),
      /cURL response extraction failed/,
    );
  } finally {
    LLMHelperCtor.__testAxios = originalAxios;
    helper.scrubKeys();
  }
});

test('chatWithCurl falls back to common-format extraction when responsePath misses', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com',
    responsePath: 'missing.path',
  }]);

  const LLMHelperCtor = helper.__proto__.constructor;
  const originalAxios = LLMHelperCtor.__testAxios;
  LLMHelperCtor.__testAxios = async () => ({ data: { choices: [{ message: { content: 'fallback content' } }] } });

  try {
    const response = await helper.chatWithCurl('hello');
    assert.equal(response, 'fallback content');
  } finally {
    LLMHelperCtor.__testAxios = originalAxios;
    helper.scrubKeys();
  }
});
