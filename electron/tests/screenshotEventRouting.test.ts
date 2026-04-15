import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { SCREENSHOT_EVENT_PROMPT } from '../llm/prompts';

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

test('classifyScreenshotContent identifies coding and mixed technical content', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  const codingCategory = helper.classifyScreenshotContent(
    'Please solve this screenshot question',
    undefined,
    'Given an array nums and target, return indices. Constraints: 2 <= n <= 10^4. Time complexity O(n).',
  );
  const mixedCategory = helper.classifyScreenshotContent(
    'Design a URL shortener and show sample code',
    undefined,
    'Use a load balancer, shard the database, and implement function generateKey() { return hash(id); }',
  );

  assert.equal(codingCategory, 'coding_algorithmic');
  assert.equal(mixedCategory, 'mixed_content');
  helper.scrubKeys();
});

test('prepareScreenshotEventRouting builds OCR-grounded routing payload', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.buildScreenshotOcrSummary = async () => ({
    text: 'Given an array nums and target, return indices.',
    averageConfidence: 62.4,
    lowConfidence: true,
    notes: ['Image 1: OCR confidence 62.4%'],
  });

  const routing = await helper.prepareScreenshotEventRouting({
    message: 'solve this',
    context: 'interview context',
    imagePaths: ['/tmp/screenshot.png'],
  });

  assert.equal(routing.systemPrompt, SCREENSHOT_EVENT_PROMPT);
  assert.match(routing.userMessage, /OCR_EXTRACTED_TEXT:/);
  assert.match(routing.userMessage, /OCR_EXTRACTION_QUALITY_NOTES:/);
  assert.match(routing.userMessage, /PRELIMINARY_CLASSIFICATION_HINT: coding_algorithmic/);
  helper.scrubKeys();
});

test('prepareScreenshotEventRouting keeps structured requests intact while appending OCR context', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.buildScreenshotOcrSummary = async () => ({
    text: 'Observed race condition in debounce implementation',
    averageConfidence: 71.2,
    lowConfidence: false,
    notes: ['Image 1: OCR confidence 71.2%'],
  });

  const routing = await helper.prepareScreenshotEventRouting({
    message: 'STRUCTURED_REASONING_RESPONSE\nReturn JSON with keys: mode, openingReasoning, implementationPlan',
    imagePaths: ['/tmp/screenshot.png'],
    structuredRequest: true,
  });

  assert.equal(routing.systemPrompt, SCREENSHOT_EVENT_PROMPT);
  assert.match(routing.userMessage, /^STRUCTURED_REASONING_RESPONSE/m);
  assert.match(routing.userMessage, /SCREENSHOT_OCR_CONTEXT:/);
  assert.match(routing.userMessage, /Preserve the original response format contract exactly\./);
  assert.doesNotMatch(routing.userMessage, /SCREENSHOT_EVENT_REQUEST/);
  helper.scrubKeys();
});

test('chatWithGemini enforces screenshot-event routing even when skipSystemPrompt is true', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalChatWithCurl = helper.chatWithCurl;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{{TEXT}}"',
    responsePath: 'choices[0].message.content',
  }]);

  helper.prepareScreenshotEventRouting = async () => ({
    userMessage: 'SCREENSHOT_ROUTED_MESSAGE',
    context: 'SCREENSHOT_ROUTED_CONTEXT',
    systemPrompt: 'SCREENSHOT_ROUTED_PROMPT',
  });

  let captured: { userMessage: string; systemPrompt?: string; context: string; imageCount: number } | null = null;
  helper.chatWithCurl = async (userMessage: string, systemPrompt?: string, context: string = '', imagePaths?: string[]) => {
    captured = {
      userMessage,
      systemPrompt,
      context,
      imageCount: imagePaths?.length || 0,
    };
    return 'ok';
  };

  try {
    const result = await helper.chatWithGemini('original message', ['/tmp/screenshot.png'], 'original context', true);
    assert.equal(result, 'ok');
    assert.equal(captured?.userMessage, 'SCREENSHOT_ROUTED_MESSAGE');
    assert.equal(captured?.context, 'SCREENSHOT_ROUTED_CONTEXT');
    assert.equal(captured?.systemPrompt, 'SCREENSHOT_ROUTED_PROMPT');
    assert.equal(captured?.imageCount, 1);
  } finally {
    helper.chatWithCurl = originalChatWithCurl;
    helper.scrubKeys();
  }
});

test('streamChat applies screenshot-event routing before cURL provider execution', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalExecuteCustomProvider = helper.executeCustomProvider;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{{TEXT}}"',
    responsePath: 'choices[0].message.content',
  }]);

  helper.prepareScreenshotEventRouting = async () => ({
    userMessage: 'SCREENSHOT_STREAM_MESSAGE',
    context: 'SCREENSHOT_STREAM_CONTEXT',
    systemPrompt: 'SCREENSHOT_STREAM_PROMPT',
  });

  let captured: {
    combinedMessage: string;
    systemPrompt: string;
    rawUserMessage: string;
    context: string;
    imageCount: number;
  } | null = null;

  helper.executeCustomProvider = async (
    _curlCommand: string,
    combinedMessage: string,
    systemPrompt: string,
    rawUserMessage: string,
    context: string,
    imagePaths?: string[],
  ) => {
    captured = {
      combinedMessage,
      systemPrompt,
      rawUserMessage,
      context,
      imageCount: imagePaths?.length || 0,
    };
    return 'stream-ok';
  };

  try {
    let output = '';
    for await (const chunk of helper.streamChat('original message', ['/tmp/screenshot.png'], 'original context', 'OVERRIDE_PROMPT')) {
      output += chunk;
    }

    assert.equal(output, 'stream-ok');
    assert.equal(captured?.rawUserMessage, 'SCREENSHOT_STREAM_MESSAGE');
    assert.equal(captured?.context, 'SCREENSHOT_STREAM_CONTEXT');
    assert.match(captured?.systemPrompt || '', /SCREENSHOT_STREAM_PROMPT/);
    assert.match(captured?.combinedMessage || '', /SCREENSHOT_STREAM_MESSAGE/);
    assert.equal(captured?.imageCount, 1);
  } finally {
    helper.executeCustomProvider = originalExecuteCustomProvider;
    helper.scrubKeys();
  }
});

test('chatWithGemini keeps structured screenshot requests on original prompt contract', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalChatWithCurl = helper.chatWithCurl;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com -d "{{TEXT}}"',
    responsePath: 'choices[0].message.content',
  }]);

  let routingInput: any = null;
  helper.prepareScreenshotEventRouting = async (input: any) => {
    routingInput = input;
    return {
      userMessage: 'STRUCTURED_SCREENSHOT_MESSAGE',
      context: 'STRUCTURED_SCREENSHOT_CONTEXT',
      systemPrompt: 'SCREENSHOT_PROMPT_SHOULD_NOT_BE_USED',
    };
  };

  let captured: { userMessage: string; systemPrompt?: string; context: string } | null = null;
  helper.chatWithCurl = async (userMessage: string, systemPrompt?: string, context: string = '') => {
    captured = { userMessage, systemPrompt, context };
    return 'ok';
  };

  try {
    const structuredMessage = 'STRUCTURED_REASONING_RESPONSE\nReturn JSON with keys: mode, openingReasoning, implementationPlan';
    const result = await helper.chatWithGemini(structuredMessage, ['/tmp/screenshot.png'], 'original context', true);
    assert.equal(result, 'ok');
    assert.equal(routingInput?.structuredRequest, true);
    assert.equal(captured?.userMessage, 'STRUCTURED_SCREENSHOT_MESSAGE');
    assert.equal(captured?.context, 'STRUCTURED_SCREENSHOT_CONTEXT');
    assert.equal(captured?.systemPrompt, undefined);
  } finally {
    helper.chatWithCurl = originalChatWithCurl;
    helper.scrubKeys();
  }
});
