import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderCapability } from '../latency/providerCapability';

test('provider capability classifies cURL providers as non-streaming', () => {
  assert.equal(classifyProviderCapability({ activeCurlProvider: true }), 'non_streaming');
});

test('provider capability classifies ollama as buffered and cloud models as streaming', () => {
  assert.equal(classifyProviderCapability({ useOllama: true }), 'buffered');
  assert.equal(classifyProviderCapability({ isOpenAiModel: true }), 'streaming');
  assert.equal(classifyProviderCapability({ isClaudeModel: true }), 'streaming');
  assert.equal(classifyProviderCapability({ isGroqModel: true }), 'streaming');
  assert.equal(classifyProviderCapability({ isGeminiModel: true }), 'streaming');
});
