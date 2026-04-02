import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { AnswerLLM } from '../llm/AnswerLLM';
import { FollowUpLLM } from '../llm/FollowUpLLM';
import { WhatToAnswerLLM } from '../llm/WhatToAnswerLLM';
import type { ReasoningThread } from '../ConsciousMode';

type StreamChatCall = {
  message: string;
  imagePaths?: string[];
  context?: string;
  prompt?: string;
  options?: unknown;
};

class FakeLLMHelper {
  public readonly calls: StreamChatCall[] = [];

  constructor(
    private readonly chunks: string[] = [],
    private readonly error?: Error,
  ) {}

  streamChat(
    message: string,
    imagePaths?: string[],
    context?: string,
    prompt?: string,
    options?: unknown,
  ): AsyncGenerator<string> {
    this.calls.push({ message, imagePaths, context, prompt, options });

    if (this.error) {
      throw this.error;
    }

    const chunks = this.chunks;
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();
  }
}

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

test('AnswerLLM streams spoken answers and trims the final text', async () => {
  const helper = new FakeLLMHelper(['  first', ' second  ']);
  const llm = new AnswerLLM(helper as any);

  const response = await llm.generate('How would you design a cache?', 'ctx');

  assert.equal(response, 'first second');
  assert.equal(helper.calls[0]?.message, 'How would you design a cache?');
  assert.equal(helper.calls[0]?.context, 'ctx');
});

test('AnswerLLM returns an empty string when the streaming path throws', async () => {
  const helper = new FakeLLMHelper([], new Error('stream exploded'));
  const llm = new AnswerLLM(helper as any);

  const response = await llm.generate('How would you design a cache?');

  assert.equal(response, '');
});

test('AnswerLLM requests the concise structured reasoning contract and parses it', async () => {
  const helper = new FakeLLMHelper([
    JSON.stringify({
      mode: 'reasoning_first',
      questionType: 'approach',
      openingReasoning: 'I would start with the write pattern and eviction policy.',
      spokenResponse: 'I would use Redis first because it keeps latency predictable.',
      tradeoffs: ['Redis adds infra overhead.'],
      likelyFollowUps: ['How would you shard it?'],
    }),
  ]);
  const llm = new AnswerLLM(helper as any);

  const response = await llm.generateReasoningFirst('How would you design a cache?', 'ctx');
  const request = helper.calls[0];

  assert.ok(request);
  assert.match(request.message, /STRUCTURED_REASONING_RESPONSE/);
  assert.match(request.message, /mode, questionType, openingReasoning, spokenResponse, codeBlock, tradeoffs, likelyFollowUps/i);
  assert.match(request.message, /Legacy compatibility keys implementationPlan, edgeCases, scaleConsiderations, pushbackResponses, and codeTransition/i);
  assert.equal(request.context, 'ctx');
  assert.equal(response.mode, 'reasoning_first');
  assert.equal(response.questionType, 'approach');
  assert.equal(response.spokenResponse, 'I would use Redis first because it keeps latency predictable.');
});

test('AnswerLLM returns an invalid structured response when reasoning-first generation fails', async () => {
  const helper = new FakeLLMHelper([], new Error('reasoning failed'));
  const llm = new AnswerLLM(helper as any);

  const response = await llm.generateReasoningFirst('How would you design a cache?');

  assert.equal(response.mode, 'invalid');
});

test('WhatToAnswerLLM reasoning-first requests carry the concise contract plus session context', async () => {
  const helper = new FakeLLMHelper([
    JSON.stringify({
      mode: 'reasoning_first',
      questionType: 'code',
      openingReasoning: 'I would first restate the invariant.',
      spokenResponse: 'I would start with a sliding window because it avoids boundary bursts.',
      codeBlock: {
        language: 'ts',
        code: 'return limit;',
      },
      tradeoffs: ['More memory than fixed window.'],
      likelyFollowUps: ['How do you expire keys?'],
    }),
  ]);
  const llm = new WhatToAnswerLLM(helper as any);

  const response = await llm.generateReasoningFirst(
    '[INTERVIEWER] Design a rate limiter.',
    'Design a rate limiter',
    { hasRecentResponses: true, previousResponses: ['I would clarify scale first.'] } as any,
    { intent: 'system_design', answerShape: 'deep' } as any,
    ['diagram.png'],
    ['[ME] I would start with requirements.', '[INTERVIEWER] What scale matters?'],
  );
  const request = helper.calls[0];

  assert.ok(request);
  assert.match(request.message, /QUESTION: Design a rate limiter/);
  assert.match(request.message, /INTENT: system_design/);
  assert.match(request.message, /ANSWER_SHAPE: deep/);
  assert.match(request.message, /PREVIOUS_RESPONSES: I would clarify scale first\./);
  assert.match(request.message, /SESSION_HISTORY:/);
  assert.match(request.message, /\[ME\] I would start with requirements\./);
  assert.match(request.message, /\[INTERVIEWER\] What scale matters\?/);
  assert.match(request.message, /mode, questionType, openingReasoning, spokenResponse, codeBlock, tradeoffs, likelyFollowUps/i);
  assert.deepEqual(request.imagePaths, ['diagram.png']);
  assert.equal(response.mode, 'reasoning_first');
  assert.equal(response.questionType, 'code');
  assert.equal(response.codeBlock?.language, 'ts');
});

test('FollowUpLLM requests the concise follow-up contract and includes the active reasoning thread', async () => {
  const helper = new FakeLLMHelper([
    JSON.stringify({
      mode: 'reasoning_first',
      questionType: 'clarification',
      openingReasoning: 'I would stay consistent with the earlier design.',
      spokenResponse: 'I would keep the same Redis path and just explain the eviction detail.',
      tradeoffs: ['Still depends on external cache availability.'],
      likelyFollowUps: ['What if Redis is down?'],
    }),
  ]);
  const llm = new FollowUpLLM(helper as any);
  const thread: ReasoningThread = {
    rootQuestion: 'Design a rate limiter',
    lastQuestion: 'How would you shard it?',
    response: {
      mode: 'reasoning_first',
      questionType: 'approach',
      openingReasoning: 'I would partition by user id.',
      spokenResponse: 'I would shard by a stable user hash.',
      implementationPlan: [],
      tradeoffs: ['Rebalancing is painful.'],
      edgeCases: [],
      scaleConsiderations: [],
      pushbackResponses: [],
      likelyFollowUps: [],
      codeTransition: '',
    },
    followUpCount: 2,
    updatedAt: Date.now(),
  };

  const response = await llm.generateReasoningFirstFollowUp(
    thread,
    'What if Redis is unavailable?',
    'ctx',
    ['I would start with per-user keys.'],
  );
  const request = helper.calls[0];

  assert.ok(request);
  assert.match(request.message, /ACTIVE_REASONING_THREAD/);
  assert.match(request.message, /ROOT_QUESTION: Design a rate limiter/);
  assert.match(request.message, /LAST_QUESTION: How would you shard it\?/);
  assert.match(request.message, /FOLLOW_UP_QUESTION: What if Redis is unavailable\?/);
  assert.match(request.message, /PREVIOUS_RESPONSES: I would start with per-user keys\./);
  assert.match(request.message, /mode, questionType, openingReasoning, spokenResponse, codeBlock, tradeoffs, likelyFollowUps/i);
  assert.equal(request.context, 'ctx');
  assert.equal(response.mode, 'reasoning_first');
  assert.equal(response.questionType, 'clarification');
});

test('FollowUpLLM returns an empty string when the direct follow-up stream throws', async () => {
  const helper = new FakeLLMHelper([], new Error('follow-up failed'));
  const llm = new FollowUpLLM(helper as any);

  const response = await llm.generate('previous answer', 'make it shorter');

  assert.equal(response, '');
});

test('FollowUpLLM generateStream swallows stream failures without yielding fallback text', async () => {
  const helper = new FakeLLMHelper([], new Error('stream follow-up failed'));
  const llm = new FollowUpLLM(helper as any);

  const chunks: string[] = [];
  for await (const chunk of llm.generateStream('previous answer', 'make it shorter')) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, []);
});

test('FollowUpLLM returns an invalid structured response when reasoning-first follow-up generation fails', async () => {
  const helper = new FakeLLMHelper([], new Error('reasoning follow-up failed'));
  const llm = new FollowUpLLM(helper as any);
  const thread: ReasoningThread = {
    rootQuestion: 'Design a rate limiter',
    lastQuestion: 'How would you shard it?',
    response: {
      mode: 'reasoning_first',
      questionType: 'approach',
      openingReasoning: 'I would shard by key.',
      spokenResponse: 'I would shard by a stable hash.',
      implementationPlan: [],
      tradeoffs: [],
      edgeCases: [],
      scaleConsiderations: [],
      pushbackResponses: [],
      likelyFollowUps: [],
      codeTransition: '',
    },
    followUpCount: 1,
    updatedAt: Date.now(),
  };

  const response = await llm.generateReasoningFirstFollowUp(thread, 'What if Redis is unavailable?');

  assert.equal(response.mode, 'invalid');
});

test('LLMHelper brevity hints skip structured or detailed prompts and tighten plain questions', async () => {
  const LLMHelper = await loadLLMHelper();
  const helper = new LLMHelper() as any;

  const plain = helper.applyDefaultBrevityHint('Explain distributed caching');
  const detailed = helper.applyDefaultBrevityHint('Explain distributed caching in detail');
  const structured = helper.applyDefaultBrevityHint(
    'Return JSON with keys: mode, questionType, openingReasoning, spokenResponse, codeBlock, tradeoffs, likelyFollowUps.',
  );

  assert.match(plain, /Answer briefly and directly\. Keep it to 2-3 short sentences unless code is required\./);
  assert.equal(detailed, 'Explain distributed caching in detail');
  assert.equal(
    structured,
    'Return JSON with keys: mode, questionType, openingReasoning, spokenResponse, codeBlock, tradeoffs, likelyFollowUps.',
  );

  helper.scrubKeys();
});
