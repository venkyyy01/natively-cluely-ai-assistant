import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { fetchProviderModels } from '../utils/modelFetcher';

test('fetchProviderModels returns only chat-capable Cerebras models', async () => {
  const originalGet = axios.get;
  let seenUrl = '';
  let seenAuth = '';

  (axios as any).get = async (url: string, config: any) => {
    seenUrl = url;
    seenAuth = config?.headers?.Authorization || '';

    return {
      data: {
        data: [
          { id: 'gpt-oss-120b' },
          { id: 'qwen-3-32b' },
          { id: 'text-embedding-3-large' },
          { id: 'speech-realtime-preview' },
        ],
      },
    };
  };

  try {
    const models = await fetchProviderModels('cerebras', 'csk_test');

    assert.equal(seenUrl, 'https://api.cerebras.ai/v1/models');
    assert.equal(seenAuth, 'Bearer csk_test');
    assert.deepEqual(models, [
      { id: 'gpt-oss-120b', label: 'gpt-oss-120b' },
      { id: 'qwen-3-32b', label: 'qwen-3-32b' },
    ]);
  } finally {
    (axios as any).get = originalGet;
  }
});
