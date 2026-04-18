import test from 'node:test';
import assert from 'node:assert/strict';
import { WhatToAnswerLLM } from '../llm/WhatToAnswerLLM';
import {
  CONSCIOUS_BEHAVIORAL_REASONING_SYSTEM_PROMPT,
  CONSCIOUS_REASONING_SYSTEM_PROMPT,
} from '../llm/prompts';

type CapturedCall = {
  message: string;
  prompt?: string;
  options?: {
    skipKnowledgeInterception?: boolean;
    abortSignal?: AbortSignal;
    qualityTier?: 'fast' | 'standard' | 'structured_reasoning';
  };
};

class CapturingLLMHelper {
  public calls: CapturedCall[] = [];

  async *streamChat(
    message: string,
    _imagePaths?: string[],
    _context?: string,
    prompt?: string,
    options?: CapturedCall['options'],
  ): AsyncGenerator<string> {
    this.calls.push({ message, prompt, options });
    yield JSON.stringify({
      mode: 'reasoning_first',
      openingReasoning: 'I would start with requirements and then lock API boundaries.',
      implementationPlan: ['Clarify constraints'],
      tradeoffs: ['A stricter API contract slows initial iteration'],
      edgeCases: ['Ambiguous idempotency keys'],
      scaleConsiderations: ['Shard by tenant'],
      pushbackResponses: ['I prefer correctness before optimization here.'],
      likelyFollowUps: ['How do you handle failover?'],
      codeTransition: 'Then I would sketch the request validation layer.',
    });
  }
}

test('WhatToAnswerLLM reasoning-first uses conscious structured routing options', async () => {
  const helper = new CapturingLLMHelper();
  const llm = new WhatToAnswerLLM(helper as any);

  const result = await llm.generateReasoningFirst(
    '[INTERVIEWER]: How would you design this?',
    'How would you design this?',
  );

  assert.equal(result.mode, 'reasoning_first');
  assert.equal(helper.calls.length, 1);
  assert.equal(helper.calls[0].prompt, CONSCIOUS_REASONING_SYSTEM_PROMPT);
  assert.equal(helper.calls[0].options?.skipKnowledgeInterception, true);
  assert.equal(helper.calls[0].options?.qualityTier, 'structured_reasoning');
});

test('WhatToAnswerLLM selects the dedicated behavioral reasoning prompt for behavioral intents', async () => {
  const helper = new CapturingLLMHelper();
  const llm = new WhatToAnswerLLM(helper as any);

  const result = await llm.generateReasoningFirst(
    '[INTERVIEWER]: How do you make difficult decisions?\n<conscious_answer_plan>\nQUESTION_MODE: behavioral\n</conscious_answer_plan>',
    'How do you make difficult decisions?',
    undefined,
    {
      intent: 'behavioral',
      confidence: 0.91,
      answerShape: 'Give a short approach statement and one grounded STAR example.',
    },
  );

  assert.equal(result.mode, 'reasoning_first');
  assert.equal(helper.calls.length, 1);
  assert.equal(helper.calls[0].prompt, CONSCIOUS_BEHAVIORAL_REASONING_SYSTEM_PROMPT);
});
