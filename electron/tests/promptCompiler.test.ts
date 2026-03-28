import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PromptCompiler } from '../llm/PromptCompiler';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';

describe('PromptCompiler', () => {
  let compiler: PromptCompiler;

  beforeEach(() => {
    setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS, accelerationEnabled: true });
    compiler = new PromptCompiler();
  });

  it('should compile prompts with deduplicated components', async () => {
    const result = await compiler.compile({
      provider: 'openai',
      phase: 'deep_dive',
      mode: 'conscious',
    });

    assert(result.systemPrompt.length > 0);
    assert(result.systemPrompt.includes('Natively'));
  });

  it('should cache compiled prompts', async () => {
    const result1 = await compiler.compile({
      provider: 'openai',
      phase: 'deep_dive',
      mode: 'conscious',
    });

    const result2 = await compiler.compile({
      provider: 'openai',
      phase: 'deep_dive',
      mode: 'conscious',
    });

    assert.strictEqual(result1.systemPrompt, result2.systemPrompt);
  });

  it('should estimate token count accurately', async () => {
    const result = await compiler.compile({
      provider: 'openai',
      phase: 'deep_dive',
      mode: 'conscious',
    });

    assert(result.estimatedTokens > 0);
    assert(result.estimatedTokens < 5000);
  });
});
