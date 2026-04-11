import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as fsPromises from 'node:fs/promises';

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

test('executeCustomProvider injects image arrays and counts for multimodal templates', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalFetch = globalThis.fetch;

  const imagePathA = '/tmp/custom-provider-image-a.png';
  const imagePathB = '/tmp/custom-provider-image-b.png';
  await Promise.all([
    fsPromises.writeFile(imagePathA, Buffer.from('a-image')),
    fsPromises.writeFile(imagePathB, Buffer.from('b-image')),
  ]);

  let seenBody = '';
  globalThis.fetch = (async (_url, init) => {
    seenBody = String(init?.body || '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const response = await helper.executeCustomProvider(
      `curl https://example.com -H "Content-Type: application/json" -d '{"images":{{IMAGE_BASE64S}},"count":"{{IMAGE_COUNT}}","user":"{{USER_MESSAGE}}","context":"{{CONTEXT}}"}'`,
      'combined text',
      'system text',
      'user text',
      'ctx text',
      [imagePathA, imagePathB],
    );

    assert.equal(response, 'ok');
    const parsed = JSON.parse(seenBody);
    assert.deepEqual(Array.isArray(parsed.images), true);
    assert.equal(parsed.images.length, 2);
    assert.equal(parsed.count, '2');
    assert.equal(parsed.user, 'user text');
    assert.equal(parsed.context, 'ctx text');
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.allSettled([
      fsPromises.unlink(imagePathA),
      fsPromises.unlink(imagePathB),
    ]);
    helper.scrubKeys();
  }
});

test('executeCustomProvider supports unescaped JSON templates from curl export tools', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalFetch = globalThis.fetch;

  let seenBody = '';
  globalThis.fetch = (async (_url, init) => {
    seenBody = String(init?.body || '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const response = await helper.executeCustomProvider(
      'curl https://example.com -H "Content-Type: application/json" -d "{\\\"messages\\\":{{OPENAI_MESSAGES}}}"',
      'combined',
      'system',
      'user text',
      'ctx',
      [],
    );

    assert.equal(response, 'ok');
    const parsed = JSON.parse(seenBody);
    assert.deepEqual(Array.isArray(parsed.messages), true);
    assert.equal(parsed.messages.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
    helper.scrubKeys();
  }
});
