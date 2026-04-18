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
    assert.doesNotMatch(captured?.userMessage || '', /Answer briefly and directly\./);
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

test('chatWithGemini falls back to local OCR for Ollama screenshot requests', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let capturedPrompt = '';

  helper.setModel('ollama-llama3.2', []);
  helper.extractImageTextWithTesseract = async () => 'Ollama OCR fallback text';
  helper.callOllama = async (prompt: string) => {
    capturedPrompt = prompt;
    return 'ollama-ok';
  };

  try {
    const result = await helper.chatWithGemini('solve this', ['/tmp/screenshot.png'], 'ctx', true);
    assert.equal(result, 'ollama-ok');
    assert.match(capturedPrompt, /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(capturedPrompt, /Ollama OCR fallback text/);
    assert.match(capturedPrompt, /coding \/ technical interview problem/);
    assert.match(capturedPrompt, /non-technical content/);
    assert.match(capturedPrompt, /Problem restatement/);
    assert.match(capturedPrompt, /Brute-force code/);
    assert.match(capturedPrompt, /Optimized code/);
    assert.doesNotMatch(capturedPrompt, /Answer briefly and directly\./);
  } finally {
    helper.scrubKeys();
  }
});

test('analyzeImageFiles uses the screenshot prompt and OCR fallback for text-only cURL providers', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalChatWithCurl = helper.chatWithCurl;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{\"prompt\":\"{{TEXT}}\"}"',
    responsePath: 'choices[0].message.content',
  }]);

  helper.extractImageTextWithTesseract = async () => 'Analyze image OCR fallback text';

  let captured: { userMessage: string; systemPrompt?: string; imageCount: number } | null = null;
  helper.chatWithCurl = async (userMessage: string, systemPrompt?: string, _context: string = '', imagePaths?: string[]) => {
    captured = {
      userMessage,
      systemPrompt,
      imageCount: imagePaths?.length || 0,
    };
    return 'analysis-ok';
  };

  try {
    const result = await helper.analyzeImageFiles(['/tmp/screenshot.png']);
    assert.equal(result.text, 'analysis-ok');
    assert.equal(captured?.imageCount, 0);
    assert.match(captured?.userMessage || '', /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(captured?.userMessage || '', /Analyze image OCR fallback text/);
    assert.match(captured?.systemPrompt || '', /You are an expert software engineer and technical interview coach\./);
    assert.match(captured?.systemPrompt || '', /coding \/ technical interview problem/);
    assert.match(captured?.systemPrompt || '', /non-technical content/);
    assert.match(captured?.systemPrompt || '', /Problem restatement/);
    assert.match(captured?.systemPrompt || '', /Brute-force overview/);
    assert.match(captured?.systemPrompt || '', /Big-O summary/);
  } finally {
    helper.chatWithCurl = originalChatWithCurl;
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

test('streamChat preserves structured system prompt overrides for screenshot reasoning requests', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalExecuteCustomProvider = helper.executeCustomProvider;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{\"prompt\":\"{{TEXT}}\"}"',
    responsePath: 'choices[0].message.content',
  }]);

  helper.extractImageTextWithTesseract = async () => 'Structured screenshot fallback text';

  let captured: {
    systemPrompt: string;
    rawUserMessage: string;
  } | null = null;

  helper.executeCustomProvider = async (
    _curlCommand: string,
    _combinedMessage: string,
    systemPrompt: string,
    rawUserMessage: string,
  ) => {
    captured = {
      systemPrompt,
      rawUserMessage,
    };
    return 'structured-ok';
  };

  try {
    const structuredPromptOverride = 'STRUCTURED_REASONING_RESPONSE\nPROMPT_MARKER_KEEP_OVERRIDE';
    let output = '';
    for await (const chunk of helper.streamChat(
      'Please reason from the screenshot before coding',
      ['/tmp/screenshot.png'],
      'ctx',
      structuredPromptOverride,
      { qualityTier: 'structured_reasoning' },
    )) {
      output += chunk;
    }

    assert.equal(output, 'structured-ok');
    assert.match(captured?.systemPrompt || '', /PROMPT_MARKER_KEEP_OVERRIDE/);
    assert.doesNotMatch(captured?.systemPrompt || '', /Problem restatement/);
    assert.match(captured?.rawUserMessage || '', /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(captured?.rawUserMessage || '', /Structured screenshot fallback text/);
  } finally {
    helper.executeCustomProvider = originalExecuteCustomProvider;
    helper.scrubKeys();
  }
});

test('chatWithGemini retries cURL screenshot requests with OCR text when image input is rejected', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalChatWithCurl = helper.chatWithCurl;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{\"image\":\"{{IMAGE_BASE64}}\",\"prompt\":\"{{TEXT}}\"}"',
    responsePath: 'choices[0].message.content',
  }]);

  helper.extractImageTextWithTesseract = async () => 'OCR retry text from screenshot';

  const calls: Array<{ userMessage: string; imageCount: number }> = [];
  helper.chatWithCurl = async (userMessage: string, _systemPrompt?: string, _context: string = '', imagePaths?: string[]) => {
    calls.push({
      userMessage,
      imageCount: imagePaths?.length || 0,
    });
    if (imagePaths?.length) {
      throw new Error('image_url content is not supported by this model');
    }
    return 'ocr-retry-ok';
  };

  try {
    const result = await helper.chatWithGemini('solve this', ['/tmp/screenshot.png'], 'ctx', true);
    assert.equal(result, 'ocr-retry-ok');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].imageCount, 1);
    assert.equal(calls[1].imageCount, 0);
    assert.doesNotMatch(calls[0].userMessage, /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(calls[1].userMessage, /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(calls[1].userMessage, /OCR retry text from screenshot/);
  } finally {
    helper.chatWithCurl = originalChatWithCurl;
    helper.scrubKeys();
  }
});

test('streamChat retries selected OpenAI screenshot requests with OCR text when image input is rejected', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('gpt-5.4-chat', []);
  helper.openaiClient = { chat: { completions: { create: async () => ({}) } } };
  helper.extractImageTextWithTesseract = async () => 'OpenAI OCR retry text';

  let capturedTextUserMessage = '';
  let capturedTextSystemPrompt = '';
  helper.streamWithOpenaiMultimodal = async function* () {
    throw new Error('This model does not support image input');
  };
  helper.streamWithOpenai = async function* (userMessage: string, systemPrompt?: string) {
    capturedTextUserMessage = userMessage;
    capturedTextSystemPrompt = systemPrompt || '';
    yield 'openai-ocr-ok';
  };

  try {
    let output = '';
    for await (const chunk of helper.streamChat('solve this', ['/tmp/screenshot.png'], 'ctx')) {
      output += chunk;
    }

    assert.equal(output, 'openai-ocr-ok');
    assert.match(capturedTextUserMessage, /SCREENSHOT_TEXT_FALLBACK:/);
    assert.match(capturedTextUserMessage, /OpenAI OCR retry text/);
    assert.match(capturedTextSystemPrompt, /Problem restatement/);
    assert.match(capturedTextSystemPrompt, /Optimized complexity/);
  } finally {
    helper.scrubKeys();
  }
});
