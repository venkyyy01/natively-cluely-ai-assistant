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

test('executeCustomProvider throws on HTTP errors instead of treating them as model output', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;

  try {
    await assert.rejects(
      () => helper.executeCustomProvider(
        'curl https://example.com -H "Content-Type: application/json" -d "{}"',
        'hello',
        '',
        'hello',
        '',
      ),
      /Custom Provider HTTP 502: bad gateway/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    helper.scrubKeys();
  }
});

test('executeCustomProvider rejects oversized response bodies before parsing', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response('ok', {
    status: 200,
    headers: { 'content-length': String(3 * 1024 * 1024) },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => helper.executeCustomProvider(
        'curl https://example.com -H "Content-Type: application/json" -d "{}"',
        'hello',
        '',
        'hello',
        '',
      ),
      /Provider response exceeded/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    helper.scrubKeys();
  }
});
