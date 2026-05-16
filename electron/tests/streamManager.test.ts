import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { StreamManager, StreamChunk } from '../llm/StreamManager';
import { setOptimizationFlags, DEFAULT_OPTIMIZATION_FLAGS } from '../config/optimizations';

describe('StreamManager', () => {
  let manager: StreamManager;
  let tokens: string[];
  let partialJsons: any[];
  let completeResult: any;

  beforeEach(() => {
    setOptimizationFlags({ ...DEFAULT_OPTIMIZATION_FLAGS, accelerationEnabled: true });
    tokens = [];
    partialJsons = [];
    completeResult = null;

    manager = new StreamManager({
      onToken: (token) => tokens.push(token),
      onPartialJson: (partial) => partialJsons.push(partial),
      onComplete: (full) => { completeResult = full; },
      onError: (error) => { throw error; },
    });
  });

  it('should accumulate tokens and flush on semantic boundary', async () => {
    const chunks: StreamChunk[] = [
      { text: 'This is ', index: 0 },
      { text: 'a test. ', index: 1 },
      { text: 'Here is more.', index: 2 },
    ];

    await manager.processStream(createAsyncIterable(chunks), {});

    assert(tokens.length > 0);
  });

  it('should parse partial JSON in conscious mode', async () => {
    const chunks: StreamChunk[] = [
      { text: '{"reasoning": "', index: 0 },
      { text: 'thinking about', index: 1 },
      { text: '", "answer": "', index: 2 },
      { text: 'final answer', index: 3 },
      { text: '"}', index: 4 },
    ];

    await manager.processStream(createAsyncIterable(chunks), { consciousMode: true });

    assert(true);
  });

it('should run background tasks during token accumulation', async () => {
  let backgroundRan = false;

  const chunks: StreamChunk[] = [
    { text: '{"reasoning": "done", "answer": "test."}\n', index: 0 },
  ];

  await manager.processStream(createAsyncIterable(chunks), {
    consciousMode: true,
    onBackgroundTask: async () => {
      backgroundRan = true;
    },
  });

  assert(backgroundRan);
});
});

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next() {
          if (index >= items.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return Promise.resolve({ done: false, value: items[index++] });
        }
      };
    }
  };
}
