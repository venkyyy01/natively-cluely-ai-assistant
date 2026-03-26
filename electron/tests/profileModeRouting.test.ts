import test from 'node:test';
import assert from 'node:assert/strict';
import { WhatToAnswerLLM } from '../llm/WhatToAnswerLLM';

class FakeLLMHelper {
  public calls: Array<{ message: string; context?: string; prompt?: string; options?: { skipKnowledgeInterception?: boolean } }> = [];

  async *streamChat(
    message: string,
    _imagePaths?: string[],
    context?: string,
    prompt?: string,
    options?: { skipKnowledgeInterception?: boolean },
  ): AsyncGenerator<string> {
    this.calls.push({ message, context, prompt, options });
    yield 'profile-grounded answer';
  }
}

test('WhatToAnswerLLM sends the latest profile question separately from transcript context on enriched routes', async () => {
  const llmHelper = new FakeLLMHelper();
  const llm = new WhatToAnswerLLM(llmHelper as any);

  let answer = '';
  for await (const chunk of llm.generateStream(
    'INTERVIEWER: Tell me about yourself\nME: I have worked on distributed systems.',
    undefined,
    undefined,
    undefined,
    { fastPath: false, latestQuestion: 'Tell me about yourself' } as any,
  )) {
    answer += chunk;
  }

  assert.equal(answer, 'profile-grounded answer');
  assert.equal(llmHelper.calls.length, 1);
  assert.equal(llmHelper.calls[0].message, 'Tell me about yourself');
  assert.match(llmHelper.calls[0].context || '', /CONVERSATION:/);
  assert.match(llmHelper.calls[0].context || '', /distributed systems/);
  assert.equal(llmHelper.calls[0].options?.skipKnowledgeInterception, false);
});

test('WhatToAnswerLLM still falls back gracefully when enriched stream generation throws', async () => {
  const llm = new WhatToAnswerLLM({
    async *streamChat(): AsyncGenerator<string> {
      throw new Error('knowledge enrichment failed');
    },
  } as any);

  let answer = '';
  for await (const chunk of llm.generateStream(
    'INTERVIEWER: Walk me through your resume',
    undefined,
    undefined,
    undefined,
    { fastPath: false, latestQuestion: 'Walk me through your resume' } as any,
  )) {
    answer += chunk;
  }

  assert.match(answer, /Could you repeat that\? I want to make sure I address your question properly\./);
});
