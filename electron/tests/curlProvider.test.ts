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

test('chatWithCurl injects text, context, and image placeholders for mixed multimodal payloads', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: "curl https://example.com -H 'Content-Type: application/json' -d '{\"prompt\":\"{{TEXT}}\",\"user\":\"{{USER_MESSAGE}}\",\"context\":\"{{CONTEXT}}\",\"image\":\"{{IMAGE_BASE64}}\",\"images\":{{IMAGE_BASE64S}},\"count\":\"{{IMAGE_COUNT}}\"}'",
    responsePath: 'choices[0].message.content',
  }]);

  const LLMHelperCtor = helper.__proto__.constructor;
  const originalAxios = LLMHelperCtor.__testAxios;

  const imageData = Buffer.from('fake-image-content');
  const imagePath = '/tmp/curl-provider-test-image.png';
  await fsPromises.writeFile(imagePath, imageData);

  let seenRequest: any;
  LLMHelperCtor.__testAxios = async (config: any) => {
    seenRequest = config;
    return { data: { choices: [{ message: { content: 'ok' } }] } };
  };

  try {
    const response = await helper.chatWithCurl('hello text', 'system prompt', 'extra context', [imagePath]);
    assert.equal(response, 'ok');
    assert.match(String(seenRequest.data.prompt), /system prompt/);
    assert.match(String(seenRequest.data.prompt), /CONTEXT:\nextra context/);
    assert.match(String(seenRequest.data.prompt), /USER QUESTION:\nhello text/);
    assert.equal(seenRequest.data.user, 'hello text');
    assert.equal(seenRequest.data.context, 'extra context');
    assert.equal(typeof seenRequest.data.image, 'string');
    assert.equal(seenRequest.data.image.length > 0, true);
    assert.deepEqual(Array.isArray(seenRequest.data.images), true);
    assert.equal(seenRequest.data.images.length, 1);
    assert.equal(seenRequest.data.count, '1');
  } finally {
    LLMHelperCtor.__testAxios = originalAxios;
    await Promise.allSettled([fsPromises.unlink(imagePath)]);
    helper.scrubKeys();
  }
});

test('chatWithCurl supports image-only payloads without requiring text placeholder in curl template', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: "curl https://example.com -H 'Content-Type: application/json' -d '{\"image\":\"{{IMAGE_BASE64}}\",\"count\":\"{{IMAGE_COUNT}}\"}'",
    responsePath: 'choices[0].message.content',
  }]);

  const LLMHelperCtor = helper.__proto__.constructor;
  const originalAxios = LLMHelperCtor.__testAxios;
  const imageData = Buffer.from('image-only-content');
  const imagePath = '/tmp/curl-provider-test-image-only.png';
  await fsPromises.writeFile(imagePath, imageData);

  let seenRequest: any;
  LLMHelperCtor.__testAxios = async (config: any) => {
    seenRequest = config;
    return { data: { choices: [{ message: { content: 'image-only-ok' } }] } };
  };

  try {
    const response = await helper.chatWithCurl('', undefined, '', [imagePath]);
    assert.equal(response, 'image-only-ok');
    assert.equal(typeof seenRequest.data.image, 'string');
    assert.equal(seenRequest.data.image.length > 0, true);
    assert.equal(seenRequest.data.count, '1');
  } finally {
    LLMHelperCtor.__testAxios = originalAxios;
    await Promise.allSettled([fsPromises.unlink(imagePath)]);
    helper.scrubKeys();
  }
});

test('chatWithCurl supports OpenAI-compatible {{OPENAI_MESSAGES}} payloads with image + text', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: "curl https://example.com -H 'Content-Type: application/json' -d '{\"model\":\"gpt-4o-mini\",\"messages\":{{OPENAI_MESSAGES}}}'",
    responsePath: 'choices[0].message.content',
  }]);

  const LLMHelperCtor = helper.__proto__.constructor;
  const originalAxios = LLMHelperCtor.__testAxios;
  const imagePath = '/tmp/curl-provider-openai-messages-image.png';
  await fsPromises.writeFile(imagePath, Buffer.from('openai-messages-image'));

  let seenRequest: any;
  LLMHelperCtor.__testAxios = async (config: any) => {
    seenRequest = config;
    return { data: { choices: [{ message: { content: 'openai-compatible-ok' } }] } };
  };

  try {
    const response = await helper.chatWithCurl('hello prompt', 'system instruction', 'ctx info', [imagePath]);
    assert.equal(response, 'openai-compatible-ok');
    assert.equal(seenRequest.data.model, 'gpt-4o-mini');
    assert.deepEqual(Array.isArray(seenRequest.data.messages), true);
    assert.equal(seenRequest.data.messages[0]?.role, 'system');
    assert.equal(seenRequest.data.messages[1]?.role, 'user');
    assert.deepEqual(Array.isArray(seenRequest.data.messages[1]?.content), true);
    assert.equal(seenRequest.data.messages[1].content.some((part: any) => part.type === 'text'), true);
    assert.equal(seenRequest.data.messages[1].content.some((part: any) => part.type === 'image_url'), true);
  } finally {
    LLMHelperCtor.__testAxios = originalAxios;
    await Promise.allSettled([fsPromises.unlink(imagePath)]);
    helper.scrubKeys();
  }
});
