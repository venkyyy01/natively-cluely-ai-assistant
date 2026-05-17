import test from 'node:test';
import assert from 'node:assert/strict';

import {
  withRetryAndTimeout,
  createGeminiClient,
  createAnthropicClient,
  createOpenAIClient,
  createGroqClient,
  createCerebrasClient,
  createOllamaClient,
  type ProviderClient,
  type ProviderRequest,
} from '../llm/providers/ProviderClient';

function makeStubClient(name: string, behavior: 'ok' | 'retryable' | 'fatal'): ProviderClient {
  let calls = 0;
  return {
    name,
    async *stream(_req: ProviderRequest, _signal?: AbortSignal) {
      calls += 1;
      if (behavior === 'ok') {
        yield { kind: 'token', text: 'hello' };
      } else if (behavior === 'retryable') {
        yield { kind: 'error', code: 'timeout', message: 'timed out', retryable: true };
      } else {
        yield { kind: 'error', code: 'auth', message: 'bad key', retryable: false };
      }
    },
  };
}

test('NAT-064: ProviderClient yields token on success', async () => {
  const client = makeStubClient('test', 'ok');
  const events: Array<{ kind: string }> = [];
  for await (const event of client.stream({ message: 'hi' })) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'token');
});

test('NAT-064: retry wrapper retries on retryable error then succeeds', async () => {
  let callCount = 0;
  const client: ProviderClient = {
    name: 'flake',
    async *stream() {
      callCount += 1;
      if (callCount < 3) {
        yield { kind: 'error', code: 'timeout', message: 'retry me', retryable: true };
      } else {
        yield { kind: 'token', text: 'success' };
      }
    },
  };

  const wrapped = withRetryAndTimeout(client, { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200, timeoutMs: 1000 });
  const events: Array<{ kind: string }> = [];
  for await (const event of wrapped.stream({ message: 'hi' })) {
    events.push(event);
  }

  assert.equal(callCount, 3);
  assert.equal(events[events.length - 1].kind, 'token');
});

test('NAT-064: retry wrapper does not retry fatal errors', async () => {
  let callCount = 0;
  const client: ProviderClient = {
    name: 'fatal',
    async *stream() {
      callCount += 1;
      yield { kind: 'error', code: 'auth', message: 'bad key', retryable: false };
    },
  };

  const wrapped = withRetryAndTimeout(client, { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200, timeoutMs: 1000 });
  const events: Array<{ kind: string }> = [];
  for await (const event of wrapped.stream({ message: 'hi' })) {
    events.push(event);
  }

  assert.equal(callCount, 1);
  assert.equal(events[0].kind, 'error');
  assert.equal((events[0] as any).code, 'auth');
});

test('NAT-064: retry wrapper yields max_retries_exceeded after exhaustion', async () => {
  const client: ProviderClient = {
    name: 'always-fail',
    async *stream() {
      yield { kind: 'error', code: 'timeout', message: 'fail', retryable: true };
    },
  };

  const wrapped = withRetryAndTimeout(client, { maxRetries: 2, baseDelayMs: 30, maxDelayMs: 100, timeoutMs: 500 });
  const events: Array<{ kind: string }> = [];
  for await (const event of wrapped.stream({ message: 'hi' })) {
    events.push(event);
  }

  const last = events[events.length - 1];
  assert.equal(last.kind, 'error');
  assert.equal((last as any).code, 'max_retries_exceeded');
});

test('NAT-064: all stub clients implement ProviderClient', () => {
  const clients = [
    createGeminiClient('key'),
    createAnthropicClient('key'),
    createOpenAIClient('key'),
    createGroqClient('key'),
    createCerebrasClient('key'),
    createOllamaClient('http://localhost:11434'),
  ];

  for (const c of clients) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.stream, 'function');
  }
});

test('NAT-064: stub clients yield not_implemented error', async () => {
  const client = createGeminiClient('key');
  const events: Array<{ kind: string }> = [];
  for await (const event of client.stream({ message: 'hi' })) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'error');
  assert.equal((events[0] as any).code, 'not_implemented');
});

test('NAT-064: wrapped client name includes :retry suffix', () => {
  const client = makeStubClient('base', 'ok');
  const wrapped = withRetryAndTimeout(client);
  assert.equal(wrapped.name, 'base:retry');
});

test('NAT-064: abort signal stops retry loop early', async () => {
  const client: ProviderClient = {
    name: 'slow',
    async *stream(_req, signal) {
      if (signal?.aborted) return;
      yield { kind: 'error', code: 'timeout', message: 'fail', retryable: true };
    },
  };

  const controller = new AbortController();
  controller.abort();

  const wrapped = withRetryAndTimeout(client, { maxRetries: 5, baseDelayMs: 10, maxDelayMs: 50, timeoutMs: 100 });
  const events: Array<{ kind: string }> = [];
  for await (const event of wrapped.stream({ message: 'hi' }, controller.signal)) {
    events.push(event);
  }

  // Should stop quickly due to abort
  assert.ok(events.length <= 2, 'should not retry extensively when aborted');
});
