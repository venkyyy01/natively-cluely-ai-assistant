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
    const response = await helper.chatWithCurl('hello');
    assert.match(response, /Error: cURL response extraction failed/);
    assert.doesNotMatch(response, /^null$/);
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

test('executeCustomProvider attaches a timeout-backed abort signal to fetch', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalFetch = global.fetch;
  const originalAbortSignalTimeout = AbortSignal.timeout;
  const timeoutController = new AbortController();
  let seenTimeoutMs = 0;
  let seenSignal: AbortSignal | undefined;

  (AbortSignal as any).timeout = (timeoutMs: number) => {
    seenTimeoutMs = timeoutMs;
    return timeoutController.signal;
  };

  (global as any).fetch = async (_url: string, init?: RequestInit) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return {
      ok: true,
      json: async () => ({ text: 'custom ok' }),
    };
  };

  try {
    const result = await helper.executeCustomProvider(
      'curl https://example.com',
      'hello',
      'system prompt',
      'hello',
      'context'
    );

    assert.equal(result, 'custom ok');
    assert.equal(seenTimeoutMs, 30000);
    assert.equal(seenSignal, timeoutController.signal);
  } finally {
    (global as any).fetch = originalFetch;
    (AbortSignal as any).timeout = originalAbortSignalTimeout;
    helper.scrubKeys();
  }
});
