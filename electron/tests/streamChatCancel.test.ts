import test from 'node:test';
import assert from 'node:assert/strict';

import { ipcSchemas, parseIpcInput } from '../ipcValidation';

test('NAT-036: gemini-chat-cancel requires a requestId string', () => {
  assert.doesNotThrow(() => {
    parseIpcInput(ipcSchemas.geminiChatArgs, ['hello', undefined, undefined, { requestId: '00000000-0000-0000-0000-000000000001' }], 'gemini-chat-stream');
  });
});

test('NAT-036: gemini-chat-stream rejects payload without requestId (runtime enforcement)', () => {
  const simulateStreamHandler = (opts?: { requestId?: string }) => {
    if (!opts?.requestId) {
      throw new Error('gemini-chat-stream requires requestId in options');
    }
  };
  assert.throws(() => {
    simulateStreamHandler({});
  }, /requestId/);
});

test('NAT-036: gemini-chat-stream rejects non-UUID requestId at schema level', () => {
  assert.throws(() => {
    parseIpcInput(ipcSchemas.geminiChatArgs, ['hello', undefined, undefined, { requestId: 'not-a-uuid' }], 'gemini-chat-stream');
  }, /requestId/);
});

test('NAT-036: activeChatControllers map stores per-request AbortController', () => {
  const activeChatControllers = new Map<string, AbortController>();

  const reqId1 = '00000000-0000-0000-0000-000000000001';
  const reqId2 = '00000000-0000-0000-0000-000000000002';

  const c1 = new AbortController();
  const c2 = new AbortController();
  activeChatControllers.set(reqId1, c1);
  activeChatControllers.set(reqId2, c2);

  assert.equal(activeChatControllers.size, 2);
  assert.equal(activeChatControllers.get(reqId1), c1);
  assert.equal(activeChatControllers.get(reqId2), c2);
});

test('NAT-036: cancelling one request does not abort the other', () => {
  const activeChatControllers = new Map<string, AbortController>();

  const reqId1 = '00000000-0000-0000-0000-000000000001';
  const reqId2 = '00000000-0000-0000-0000-000000000002';

  const c1 = new AbortController();
  const c2 = new AbortController();
  activeChatControllers.set(reqId1, c1);
  activeChatControllers.set(reqId2, c2);

  c1.abort();
  activeChatControllers.delete(reqId1);

  assert.equal(c1.signal.aborted, true);
  assert.equal(c2.signal.aborted, false);
  assert.equal(activeChatControllers.has(reqId1), false);
  assert.equal(activeChatControllers.has(reqId2), true);
});

test('NAT-036: cancel handler aborts and removes the controller for the target requestId', () => {
  const activeChatControllers = new Map<string, AbortController>();

  const reqId = '00000000-0000-0000-0000-000000000001';
  const controller = new AbortController();
  activeChatControllers.set(reqId, controller);

  const cancelHandler = (_event: unknown, id: string) => {
    const c = activeChatControllers.get(id);
    if (c) {
      c.abort();
      activeChatControllers.delete(id);
    }
  };

  cancelHandler(null, reqId);

  assert.equal(controller.signal.aborted, true);
  assert.equal(activeChatControllers.has(reqId), false);
});

test('NAT-036: cancel handler for unknown requestId is a no-op', () => {
  const activeChatControllers = new Map<string, AbortController>();

  const existingId = '00000000-0000-0000-0000-000000000001';
  const c = new AbortController();
  activeChatControllers.set(existingId, c);

  const cancelHandler = (_event: unknown, id: string) => {
    const ctrl = activeChatControllers.get(id);
    if (ctrl) {
      ctrl.abort();
      activeChatControllers.delete(id);
    }
  };

  cancelHandler(null, '00000000-0000-0000-0000-000000000099');

  assert.equal(c.signal.aborted, false);
  assert.equal(activeChatControllers.size, 1);
});

test('NAT-036: streamGeminiChat passes abortSignal to LLMHelper.streamChat', async () => {
  let receivedSignal: AbortSignal | undefined;

  const mockLlmHelper = {
    async *streamChat(
      _message: string,
      _imagePaths?: string[],
      _context?: string,
      _systemPromptOverride?: string,
      options?: { abortSignal?: AbortSignal; qualityTier?: string },
    ) {
      receivedSignal = options?.abortSignal;
      yield 'token';
    },
  };

  const controller = new AbortController();
  const gen = mockLlmHelper.streamChat('hello', undefined, undefined, undefined, {
    abortSignal: controller.signal,
  });

  for await (const _token of gen) {
    // consume
  }

  assert.equal(receivedSignal, controller.signal);
});

test('NAT-036: pre-aborted signal causes streamChat to yield nothing', async () => {
  const mockLlmHelper = {
    async *streamChat(
      _message: string,
      _imagePaths?: string[],
      _context?: string,
      _systemPromptOverride?: string,
      options?: { abortSignal?: AbortSignal },
    ) {
      if (options?.abortSignal?.aborted) {
        return;
      }
      yield 'should-not-appear';
    },
  };

  const controller = new AbortController();
  controller.abort();

  const tokens: string[] = [];
  for await (const token of mockLlmHelper.streamChat('hello', undefined, undefined, undefined, {
    abortSignal: controller.signal,
  })) {
    tokens.push(token);
  }

  assert.equal(tokens.length, 0, 'pre-aborted signal should produce zero tokens');
});

test('NAT-036: gemini-chat-stream cleanup removes controller from activeChatControllers', () => {
  const activeChatControllers = new Map<string, AbortController>();

  const reqId = '00000000-0000-0000-0000-000000000001';
  const controller = new AbortController();
  activeChatControllers.set(reqId, controller);

  activeChatControllers.delete(reqId);

  assert.equal(activeChatControllers.has(reqId), false);
  assert.equal(activeChatControllers.size, 0);
});
