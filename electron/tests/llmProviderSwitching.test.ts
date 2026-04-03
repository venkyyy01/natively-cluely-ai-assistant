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

test('selected OpenAI model ids pass through unchanged to the outbound request', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenModel = '';

  helper.setModel('gpt-5.4-nano', []);
  helper.openaiClient = {
    chat: {
      completions: {
        create: async (payload: any) => {
          seenModel = payload.model;
          return { choices: [{ message: { content: 'ok' } }] };
        },
      },
    },
  };

  const result = await helper.generateWithOpenai('hello');

  assert.equal(result, 'ok');
  assert.equal(seenModel, 'gpt-5.4-nano');
  helper.scrubKeys();
});

test('selected Claude model ids pass through unchanged to the outbound request', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenModel = '';

  helper.setModel('claude-opus-5-2', []);
  helper.claudeClient = {
    messages: {
      create: async (payload: any) => {
        seenModel = payload.model;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    },
  };

  const result = await helper.chatWithGemini('hello claude model');

  assert.equal(result, 'ok');
  assert.equal(seenModel, 'claude-opus-5-2');
  helper.scrubKeys();
});

test('OpenAI model-not-found errors fall back to a safe discovered model', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const seenModels: string[] = [];
  const fallbackEvents: any[] = [];

  helper.setModel('gpt-5.4-nano', []);
  helper.resolveOpenAiFallbackModel = async () => 'gpt-5.4-mini';
  helper.setModelFallbackHandler((event: any) => fallbackEvents.push(event));
  helper.openaiClient = {
    chat: {
      completions: {
        create: async (payload: any) => {
          seenModels.push(payload.model);
          if (payload.model === 'gpt-5.4-nano') {
            const error: any = new Error('The model `gpt-5.4-nano` does not exist or you do not have access to it.');
            error.status = 404;
            throw error;
          }
          return { choices: [{ message: { content: 'fallback ok' } }] };
        },
      },
    },
  };

  const result = await helper.generateWithOpenai('hello');

  assert.equal(result, 'fallback ok');
  assert.deepEqual(seenModels, ['gpt-5.4-nano', 'gpt-5.4-mini']);
  assert.equal(helper.getCurrentModel(), 'gpt-5.4-mini');
  assert.deepEqual(fallbackEvents, [{
    provider: 'openai',
    previousModel: 'gpt-5.4-nano',
    fallbackModel: 'gpt-5.4-mini',
    reason: 'model_not_found',
  }]);
  helper.scrubKeys();
});

test('fast response config routes text-only requests through Cerebras using the selected model', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenModel = '';
  let seenMessages: any[] = [];

  helper.cerebrasClient = {
    chat: {
      completions: {
        create: async (payload: any) => {
          seenModel = payload.model;
          seenMessages = payload.messages;
          return { choices: [{ message: { content: 'cerebras fast ok' } }] };
        },
      },
    },
  };

  helper.setFastResponseConfig({ enabled: true, provider: 'cerebras', model: 'gpt-oss-120b' });
  const result = await helper.chatWithGemini('hello from fast mode');

  assert.equal(result, 'cerebras fast ok');
  assert.equal(seenModel, 'gpt-oss-120b');
  assert.equal(seenMessages.at(-1)?.role, 'user');
  assert.match(String(seenMessages.at(-1)?.content || ''), /hello from fast mode/i);
  helper.scrubKeys();
});

test('fast response streaming falls back to the default Cerebras model when none is configured', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenModel = '';

  helper.cerebrasClient = {
    chat: {
      completions: {
        create: async (payload: any) => {
          seenModel = payload.model;
          async function* stream() {
            yield { choices: [{ delta: { content: 'fast ' } }] };
            yield { choices: [{ delta: { content: 'stream' } }] };
          }
          return stream();
        },
      },
    },
  };

  helper.setFastResponseConfig({ enabled: true, provider: 'cerebras', model: '' });

  let output = '';
  for await (const chunk of helper.streamChat('hello streaming fast mode')) {
    output += chunk;
  }

  assert.equal(seenModel, 'gpt-oss-120b');
  assert.equal(output, 'fast stream');
  helper.scrubKeys();
});

test('fast response streaming does not mix fallback output after partial tokens were already emitted', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.cerebrasClient = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: 'fast partial ' } }] };
          throw new Error('cerebras interrupted');
        })(),
      },
    },
  };
  helper.openaiClient = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: 'fallback text' } }] };
        })(),
      },
    },
  };

  helper.setFastResponseConfig({ enabled: true, provider: 'cerebras', model: 'gpt-oss-120b' });

  let output = '';
  await assert.rejects(async () => {
    for await (const chunk of helper.streamChat('hello fast partial failure')) {
      output += chunk;
    }
  }, /cerebras interrupted/);

  assert.equal(output, 'fast partial ');
  helper.scrubKeys();
});

test('streamChat falls back to another provider when the selected streaming provider fails', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let openaiCalls = 0;

  helper.setModel('gpt-5.4-chat', []);
  helper.openaiClient = {
    chat: {
      completions: {
        create: async () => {
          openaiCalls += 1;
          throw new Error('openai stream down');
        },
      },
    },
  };
  helper.claudeClient = {
    messages: {
      stream: async () => (async function* () {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'claude ' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fallback' } };
      })(),
    },
  };

  let output = '';
  for await (const chunk of helper.streamChat('hello fallback')) {
    output += chunk;
  }

  assert.equal(output, 'claude fallback');
  assert.equal(openaiCalls, 1);
  helper.scrubKeys();
});

test('streamChat uses the selected Claude model id on the direct streaming route', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenModel = '';

  helper.setModel('claude-opus-5-2', []);
  helper.claudeClient = {
    messages: {
      stream: async (payload: any) => {
        seenModel = payload.model;
        return (async function* () {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'claude stream ok' } };
        })();
      },
    },
  };

  let output = '';
  for await (const chunk of helper.streamChat('hello claude stream')) {
    output += chunk;
  }

  assert.equal(output, 'claude stream ok');
  assert.equal(seenModel, 'claude-opus-5-2');
  helper.scrubKeys();
});

test('streamChat stops fallback escalation after a provider already emitted partial output', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  helper.setModel('gpt-5.4-chat', []);
  helper.openaiClient = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: 'partial ' } }] };
          throw new Error('openai stream interrupted');
        })(),
      },
    },
  };
  helper.claudeClient = {
    messages: {
      stream: async () => (async function* () {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'claude fallback' } };
      })(),
    },
  };

  let output = '';
  await assert.rejects(async () => {
    for await (const chunk of helper.streamChat('hello partial failure')) {
      output += chunk;
    }
  }, /openai stream interrupted/);

  assert.equal(output, 'partial ');
  helper.scrubKeys();
});

test('chatWithGemini escalates to higher text tiers after tier1 providers fail', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const attempts: string[] = [];

  helper.delay = async () => {};
  helper.currentModelId = 'fallback-router';
  helper.groqClient = {};
  helper.client = {};
  helper.openaiClient = null;
  helper.claudeClient = null;
  helper.modelVersionManager = {
    getTextTieredModels(family: string) {
      if (family === 'text_groq') return { tier1: 'groq-tier1', tier2: 'groq-tier2', tier3: 'groq-tier3' };
      if (family === 'text_gemini_flash') return { tier1: 'gemini-flash-tier1', tier2: 'gemini-flash-tier2', tier3: 'gemini-flash-tier3' };
      if (family === 'text_gemini_pro') return { tier1: 'gemini-pro-tier1', tier2: 'gemini-pro-tier2', tier3: 'gemini-pro-tier3' };
      return { tier1: 'unused-tier1', tier2: 'unused-tier2', tier3: 'unused-tier3' };
    },
    getAllTextTiers() {
      return [
        { family: 'text_groq', tier1: 'groq-tier1', tier2: 'groq-tier2', tier3: 'groq-tier3' },
        { family: 'text_gemini_flash', tier1: 'gemini-flash-tier1', tier2: 'gemini-flash-tier2', tier3: 'gemini-flash-tier3' },
        { family: 'text_gemini_pro', tier1: 'gemini-pro-tier1', tier2: 'gemini-pro-tier2', tier3: 'gemini-pro-tier3' },
      ];
    },
    stopScheduler() {},
  };

  helper.generateWithGroq = async (_message: string, modelOverride: string) => {
    attempts.push(`groq:${modelOverride}`);
    if (modelOverride === 'groq-tier2') {
      return 'tier2 success';
    }
    throw new Error(`failed ${modelOverride}`);
  };

  helper.tryGenerateResponse = async (_message: string, _imagePaths: string[] | undefined, modelIdOverride: string) => {
    attempts.push(`gemini:${modelIdOverride}`);
    throw new Error(`failed ${modelIdOverride}`);
  };

  const result = await helper.chatWithGemini('hello tier fallback');

  assert.equal(result, 'tier2 success');
  assert.deepEqual(attempts, [
    'groq:groq-tier1',
    'gemini:gemini-flash-tier1',
    'gemini:gemini-pro-tier1',
    'groq:groq-tier2',
  ]);
  helper.scrubKeys();
});

test('chatWithGemini multimodal fallback skips an immediate retry of the failed selected provider family', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let openaiCalls = 0;

  helper.setModel('gpt-5.4-chat', []);
  helper.openaiClient = {
    chat: {
      completions: {
        create: async () => {
          openaiCalls += 1;
          throw new Error('openai multimodal down');
        },
      },
    },
  };
  helper.client = null;
  helper.groqClient = null;
  helper.claudeClient = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'claude multimodal fallback' }],
      }),
    },
  };

  const result = await helper.chatWithGemini('hello multimodal fallback', ['/tmp/nonexistent.png']);

  assert.equal(result, 'claude multimodal fallback');
  assert.equal(openaiCalls, 1);
  helper.scrubKeys();
});

test('chatWithGemini multimodal fallback uses vision-tier model ids instead of text-tier ids', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenClaudeModel = '';

  helper.setModel('gpt-5.4-chat', []);
  helper.openaiClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('openai multimodal down');
        },
      },
    },
  };
  helper.client = null;
  helper.groqClient = null;
  helper.claudeClient = {};
  helper.modelVersionManager = {
    getTextTieredModels(family: string) {
      if (family === 'text_openai') return { tier1: 'text-openai-tier1', tier2: 'text-openai-tier2', tier3: 'text-openai-tier3' };
      if (family === 'text_gemini_flash') return { tier1: 'text-gemini-flash-tier1', tier2: 'text-gemini-flash-tier2', tier3: 'text-gemini-flash-tier3' };
      if (family === 'text_gemini_pro') return { tier1: 'text-gemini-pro-tier1', tier2: 'text-gemini-pro-tier2', tier3: 'text-gemini-pro-tier3' };
      if (family === 'text_claude') return { tier1: 'text-claude-tier1', tier2: 'text-claude-tier2', tier3: 'text-claude-tier3' };
      return { tier1: 'text-groq-tier1', tier2: 'text-groq-tier2', tier3: 'text-groq-tier3' };
    },
    getAllVisionTiers() {
      return [
        { family: 'openai', tier1: 'vision-openai-tier1', tier2: 'vision-openai-tier2', tier3: 'vision-openai-tier3' },
        { family: 'gemini_flash', tier1: 'vision-gemini-flash-tier1', tier2: 'vision-gemini-flash-tier2', tier3: 'vision-gemini-flash-tier3' },
        { family: 'claude', tier1: 'vision-claude-tier1', tier2: 'vision-claude-tier2', tier3: 'vision-claude-tier3' },
        { family: 'gemini_pro', tier1: 'vision-gemini-pro-tier1', tier2: 'vision-gemini-pro-tier2', tier3: 'vision-gemini-pro-tier3' },
        { family: 'groq_llama', tier1: 'vision-groq-tier1', tier2: 'vision-groq-tier2', tier3: 'vision-groq-tier3' },
      ];
    },
    stopScheduler() {},
  };
  helper.generateWithClaude = async (_user: string, _system?: string, _images?: string[], modelOverride?: string) => {
    seenClaudeModel = modelOverride || '';
    if (seenClaudeModel === 'vision-claude-tier1') {
      return 'vision multimodal ok';
    }
    throw new Error(`wrong model ${seenClaudeModel}`);
  };

  const result = await helper.chatWithGemini('hello multimodal vision tiers', ['/tmp/nonexistent.png']);

  assert.equal(result, 'vision multimodal ok');
  assert.equal(seenClaudeModel, 'vision-claude-tier1');
  helper.scrubKeys();
});

test('chatWithGemini routes active cURL providers through executeCustomProvider with prepared context', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let executeArgs: any[] | null = null;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com',
    responsePath: 'text',
  }]);

  helper.chatWithCurl = async () => {
    throw new Error('legacy chatWithCurl path should not be used');
  };
  helper.executeCustomProvider = async (...args: any[]) => {
    executeArgs = args;
    return 'curl custom ok';
  };

  const result = await helper.chatWithGemini('hello curl provider', undefined, 'extra context');

  assert.equal(result, 'curl custom ok');
  assert.ok(executeArgs, 'expected executeCustomProvider to be used');
  assert.match(String(executeArgs?.[1] || ''), new RegExp(String(executeArgs?.[2] || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(String(executeArgs?.[1] || ''), /CONTEXT:/);
  assert.equal(executeArgs?.[4], 'extra context');
  helper.scrubKeys();
});

test('chatWithGemini active cURL providers preserve responsePath extraction', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  const originalFetch = global.fetch;

  helper.setModel('curl-provider', [{
    id: 'curl-provider',
    name: 'cURL',
    curlCommand: 'curl https://example.com',
    responsePath: 'nested.answer',
  }]);

  (global as any).fetch = async () => ({
    ok: true,
    json: async () => ({ nested: { answer: 'response-path ok' } }),
  });

  try {
    const result = await helper.chatWithGemini('hello curl path', undefined, 'ctx');
    assert.equal(result, 'response-path ok');
  } finally {
    (global as any).fetch = originalFetch;
    helper.scrubKeys();
  }
});

test('chatWithGemini multimodal Groq fallback uses the tier-selected vision model id', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenGroqModel = '';

  helper.setModel('gpt-5.4-chat', []);
  helper.openaiClient = {
    chat: {
      completions: {
        create: async () => {
          throw new Error('openai multimodal down');
        },
      },
    },
  };
  helper.client = null;
  helper.claudeClient = null;
  helper.groqClient = {};
  helper.modelVersionManager = {
    getAllVisionTiers() {
      return [
        { family: 'openai', tier1: 'vision-openai-tier1', tier2: 'vision-openai-tier2', tier3: 'vision-openai-tier3' },
        { family: 'groq_llama', tier1: 'vision-groq-tier1', tier2: 'vision-groq-tier2', tier3: 'vision-groq-tier3' },
      ];
    },
    stopScheduler() {},
  };
  helper.generateWithGroqMultimodal = async (_user: string, _images: string[], _system?: string, modelOverride?: string) => {
    seenGroqModel = modelOverride || '';
    if (seenGroqModel === 'vision-groq-tier1') {
      return 'groq vision ok';
    }
    throw new Error(`wrong model ${seenGroqModel}`);
  };

  const result = await helper.chatWithGemini('hello multimodal groq tiers', ['/tmp/nonexistent.png']);

  assert.equal(result, 'groq vision ok');
  assert.equal(seenGroqModel, 'vision-groq-tier1');
  helper.scrubKeys();
});

test('chatWithGemini uses the selected Groq multimodal model id on the direct route', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;
  let seenGroqModel = '';

  helper.currentModelId = 'llama-4-scout-17b-16e-instruct';
  helper.groqClient = {};
  helper.generateWithGroqMultimodal = async (_user: string, _images: string[], _system?: string, modelOverride?: string) => {
    seenGroqModel = modelOverride || '';
    return 'direct groq multimodal ok';
  };

  const result = await helper.chatWithGemini('hello direct groq multimodal', ['/tmp/nonexistent.png']);

  assert.equal(result, 'direct groq multimodal ok');
  assert.equal(seenGroqModel, 'llama-4-scout-17b-16e-instruct');
  helper.scrubKeys();
});
