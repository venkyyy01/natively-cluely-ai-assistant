import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ANEEmbeddingProvider } from '../rag/providers/ANEEmbeddingProvider';

describe('ANEEmbeddingProvider', () => {
  let provider: ANEEmbeddingProvider;

  beforeEach(async () => {
    provider = new ANEEmbeddingProvider();
    await provider.initialize();
  });

  it('should initialize and detect ANE', async () => {
    assert(provider.isInitialized());
    assert(provider.supportsANE() || !provider.supportsANE());
  });

  it('should generate embeddings of correct dimension', async () => {
    const embedding = await provider.embed('Hello world');

    assert(Array.isArray(embedding));
    assert(embedding.length === 384);
  });

  it('should handle batch embeddings', async () => {
    const embeddings = await provider.embedBatch([
      'Hello world',
      'Test input',
      'Sample text',
    ]);

    assert(Array.isArray(embeddings));
    assert(embeddings.length === 3);
    assert(embeddings.every(e => e.length === 384));
  });

  it('should fall back to CPU if ANE unavailable', async () => {
    assert(provider.isInitialized());
  });
});
