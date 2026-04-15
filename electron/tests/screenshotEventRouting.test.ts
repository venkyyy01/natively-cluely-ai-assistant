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

test('chatWithGemini keeps image payload when cURL template supports image placeholders', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalChatWithCurl = helper.chatWithCurl;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{\"messages\":{{OPENAI_MESSAGES}}}"',
    responsePath: 'choices[0].message.content',
  }]);

  let captured: { userMessage: string; imageCount: number } | null = null;
  helper.chatWithCurl = async (userMessage: string, _systemPrompt?: string, _context: string = '', imagePaths?: string[]) => {
    captured = {
      userMessage,
      imageCount: imagePaths?.length || 0,
    };
    return 'ok';
  };

  try {
    const result = await helper.chatWithGemini('solve this', ['/tmp/screenshot.png'], 'ctx', true);
    assert.equal(result, 'ok');
    assert.equal(captured?.imageCount, 1);
    assert.doesNotMatch(captured?.userMessage || '', /SCREENSHOT_TEXT_FALLBACK:/);
  } finally {
    helper.chatWithCurl = originalChatWithCurl;
    helper.scrubKeys();
  }
});

test('chatWithGemini falls back to tesseract text only when cURL template has no image support', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalChatWithCurl = helper.chatWithCurl;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{\"prompt\":\"{{TEXT}}\"}"',
    responsePath: 'choices[0].message.content',
  }]);

  helper.extractImageTextWithTesseract = async () => 'Extracted fallback text from screenshot';

  let captured: { userMessage: string; imageCount: number } | null = null;
  helper.chatWithCurl = async (userMessage: string, _systemPrompt?: string, _context: string = '', imagePaths?: string[]) => {
    captured = {
      userMessage,
      imageCount: imagePaths?.length || 0,
    };
    return 'ok';
  };

  try {
    const result = await helper.chatWithGemini('solve this', ['/tmp/screenshot.png'], 'ctx', true);
    assert.equal(result, 'ok');
    assert.equal(captured?.imageCount, 0);
    assert.match(captured?.userMessage || '', /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(captured?.userMessage || '', /Extracted fallback text from screenshot/);
  } finally {
    helper.chatWithCurl = originalChatWithCurl;
    helper.scrubKeys();
  }
});

test('streamChat falls back to tesseract text only when cURL template has no image support', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalExecuteCustomProvider = helper.executeCustomProvider;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{\"prompt\":\"{{TEXT}}\"}"',
    responsePath: 'choices[0].message.content',
  }]);

  helper.extractImageTextWithTesseract = async () => 'Stream fallback text from screenshot';

  let captured: {
    rawUserMessage: string;
    imageCount: number;
  } | null = null;

  helper.executeCustomProvider = async (
    _curlCommand: string,
    _combinedMessage: string,
    _systemPrompt: string,
    rawUserMessage: string,
    _context: string,
    imagePaths?: string[],
  ) => {
    captured = {
      rawUserMessage,
      imageCount: imagePaths?.length || 0,
    };
    return 'stream-ok';
  };

  try {
    let output = '';
    for await (const chunk of helper.streamChat('solve this', ['/tmp/screenshot.png'], 'ctx', 'OVERRIDE_PROMPT')) {
      output += chunk;
    }

    assert.equal(output, 'stream-ok');
    assert.equal(captured?.imageCount, 0);
    assert.match(captured?.rawUserMessage || '', /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(captured?.rawUserMessage || '', /Stream fallback text from screenshot/);
  } finally {
    helper.executeCustomProvider = originalExecuteCustomProvider;
    helper.scrubKeys();
  }
});

test('streamChat keeps images when cURL template includes image placeholders', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalExecuteCustomProvider = helper.executeCustomProvider;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{\"image\":\"{{IMAGE_BASE64}}\",\"prompt\":\"{{TEXT}}\"}"',
    responsePath: 'choices[0].message.content',
  }]);

  let captured: {
    rawUserMessage: string;
    imageCount: number;
  } | null = null;

  helper.executeCustomProvider = async (
    _curlCommand: string,
    _combinedMessage: string,
    _systemPrompt: string,
    rawUserMessage: string,
    _context: string,
    imagePaths?: string[],
  ) => {
    captured = {
      rawUserMessage,
      imageCount: imagePaths?.length || 0,
    };
    return 'stream-ok';
  };

  try {
    let output = '';
    for await (const chunk of helper.streamChat('solve this', ['/tmp/screenshot.png'], 'ctx', 'OVERRIDE_PROMPT')) {
      output += chunk;
    }

    assert.equal(output, 'stream-ok');
    assert.equal(captured?.imageCount, 1);
    assert.doesNotMatch(captured?.rawUserMessage || '', /SCREENSHOT_TEXT_FALLBACK:/);
  } finally {
    helper.executeCustomProvider = originalExecuteCustomProvider;
    helper.scrubKeys();
  }
});
