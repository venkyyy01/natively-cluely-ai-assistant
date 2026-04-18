import test from 'node:test';
import assert from 'node:assert/strict';

import { getAnswerShapeGuidance } from '../llm/IntentClassifier';
import { FoundationModelsIntentProvider } from '../llm/providers/FoundationModelsIntentProvider';
import { resolveFoundationModelsIntentHelperPath } from '../llm/providers/FoundationModelsIntentHelperPath';

test('resolveFoundationModelsIntentHelperPath prefers packaged helper path when present', () => {
  const resolved = resolveFoundationModelsIntentHelperPath({
    env: {},
    cwd: '/workspace',
    resourcesPath: '/Applications/Natively.app/Contents/Resources',
    pathExists: (candidate) => candidate === '/Applications/Natively.app/Contents/Resources/bin/macos/foundation-intent-helper',
  });

  assert.equal(resolved, '/Applications/Natively.app/Contents/Resources/bin/macos/foundation-intent-helper');
});

test('resolveFoundationModelsIntentHelperPath supports explicit disable flag', () => {
  const resolved = resolveFoundationModelsIntentHelperPath({
    env: {
      NATIVELY_DISABLE_MACOS_FOUNDATION_INTENT_HELPER: 'true',
      NATIVELY_MACOS_FOUNDATION_INTENT_HELPER: '/tmp/override',
    },
    cwd: '/workspace',
    pathExists: () => true,
  });

  assert.equal(resolved, null);
});

test('resolveFoundationModelsIntentHelperPath falls back to dev helper binary candidates', () => {
  const resolved = resolveFoundationModelsIntentHelperPath({
    env: {},
    cwd: '/workspace',
    pathExists: (candidate) => candidate === '/workspace/applesilicon/macos-foundation-intent-helper/.build/debug/foundation-intent-helper',
  });

  assert.equal(resolved, '/workspace/applesilicon/macos-foundation-intent-helper/.build/debug/foundation-intent-helper');
});

test('FoundationModelsIntentProvider reports unavailable on non-eligible host', async () => {
  const provider = new FoundationModelsIntentProvider({
    platform: 'win32',
    arch: 'x64',
    helperPathResolver: () => '/tmp/helper',
    isOptimizationEnabled: () => true,
  });

  assert.equal(await provider.isAvailable(), false);
});

test('FoundationModelsIntentProvider reports unavailable when optimization flag is off', async () => {
  const provider = new FoundationModelsIntentProvider({
    platform: 'darwin',
    arch: 'arm64',
    helperPathResolver: () => '/tmp/helper',
    isOptimizationEnabled: () => false,
  });

  assert.equal(await provider.isAvailable(), false);
});

test('FoundationModelsIntentProvider classifies valid helper envelope', async () => {
  const provider = new FoundationModelsIntentProvider({
    platform: 'darwin',
    arch: 'arm64',
    helperPathResolver: () => '/tmp/foundation-intent-helper',
    isOptimizationEnabled: () => true,
    helperRunner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        intent: 'behavioral',
        confidence: 0.92,
        answerShape: 'Tell one concise STAR story.',
        provider: 'apple_foundation_models',
      }),
      stderr: '',
    }),
  });

  const result = await provider.classify({
    lastInterviewerTurn: 'Tell me about a time you handled conflict.',
    preparedTranscript: '[INTERVIEWER]: Tell me about a time you handled conflict.',
    assistantResponseCount: 2,
  });

  assert.equal(result.intent, 'behavioral');
  assert.equal(result.confidence, 0.92);
  assert.equal(result.answerShape, 'Tell one concise STAR story.');
});

test('FoundationModelsIntentProvider falls back to default answer shape when helper omits it', async () => {
  const provider = new FoundationModelsIntentProvider({
    platform: 'darwin',
    arch: 'arm64',
    helperPathResolver: () => '/tmp/foundation-intent-helper',
    isOptimizationEnabled: () => true,
    helperRunner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        intent: 'coding',
        confidence: 0.8,
      }),
      stderr: '',
    }),
  });

  const result = await provider.classify({
    lastInterviewerTurn: 'Implement an LRU cache in TypeScript.',
    preparedTranscript: '[INTERVIEWER]: Implement an LRU cache in TypeScript.',
    assistantResponseCount: 1,
  });

  assert.equal(result.intent, 'coding');
  assert.equal(result.answerShape, getAnswerShapeGuidance('coding'));
});

test('FoundationModelsIntentProvider compacts transcript context before invoking helper', async () => {
  let capturedRequest: any = null;
  const provider = new FoundationModelsIntentProvider({
    platform: 'darwin',
    arch: 'arm64',
    helperPathResolver: () => '/tmp/foundation-intent-helper',
    isOptimizationEnabled: () => true,
    helperRunner: async (_helperPath, request) => {
      capturedRequest = request;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          intent: 'clarification',
          confidence: 0.67,
        }),
        stderr: '',
      };
    },
  });

  await provider.classify({
    lastInterviewerTurn: 'Can you clarify why you chose Kafka?',
    preparedTranscript: [
      'PROFILE_FACTS: staff engineer, payments',
      '[INTERVIEWER]: Walk me through your system design.',
      '[ASSISTANT]: I would start with an event log and idempotent workers.',
      'UNRELATED_EVIDENCE: semantic memory block',
      '[INTERVIEWER]: Can you clarify why you chose Kafka?',
    ].join('\n'),
    assistantResponseCount: 1,
  });

  assert.equal(
    capturedRequest.preparedTranscript,
    [
      '[INTERVIEWER]: Walk me through your system design.',
      '[ASSISTANT]: I would start with an event log and idempotent workers.',
      '[INTERVIEWER]: Can you clarify why you chose Kafka?',
    ].join('\n'),
  );
});

test('FoundationModelsIntentProvider maps helper error envelope to typed error codes', async () => {
  const provider = new FoundationModelsIntentProvider({
    platform: 'darwin',
    arch: 'arm64',
    helperPathResolver: () => '/tmp/foundation-intent-helper',
    isOptimizationEnabled: () => true,
    helperRunner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: false,
        errorType: 'refusal',
        message: 'model refused',
      }),
      stderr: '',
    }),
  });

  await assert.rejects(
    provider.classify({
      lastInterviewerTurn: 'Question',
      preparedTranscript: 'Transcript',
      assistantResponseCount: 0,
    }),
    (error: any) => error?.code === 'refusal' && /model refused/i.test(String(error?.message)),
  );
});

test('FoundationModelsIntentProvider maps non-zero helper exit stderr to timeout code', async () => {
  const provider = new FoundationModelsIntentProvider({
    platform: 'darwin',
    arch: 'arm64',
    helperPathResolver: () => '/tmp/foundation-intent-helper',
    isOptimizationEnabled: () => true,
    helperRunner: async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'helper timeout after 1200ms',
    }),
  });

  await assert.rejects(
    provider.classify({
      lastInterviewerTurn: 'Question',
      preparedTranscript: 'Transcript',
      assistantResponseCount: 0,
    }),
    (error: any) => error?.code === 'timeout',
  );
});

test('FoundationModelsIntentProvider rejects invalid helper JSON envelopes', async () => {
  const provider = new FoundationModelsIntentProvider({
    platform: 'darwin',
    arch: 'arm64',
    helperPathResolver: () => '/tmp/foundation-intent-helper',
    isOptimizationEnabled: () => true,
    helperRunner: async () => ({
      exitCode: 0,
      stdout: '{not-json',
      stderr: '',
    }),
  });

  await assert.rejects(
    provider.classify({
      lastInterviewerTurn: 'Question',
      preparedTranscript: 'Transcript',
      assistantResponseCount: 0,
    }),
    (error: any) => error?.code === 'invalid_response' && /invalid json/i.test(String(error?.message)),
  );
});
