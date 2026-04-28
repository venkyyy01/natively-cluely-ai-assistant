import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRAGIndexer } from '../rag/LiveRAGIndexer';
import type { Chunk } from '../rag/SemanticChunker';

class FakeVectorStore {
  public chunks: Chunk[] = [];
  public embeddings: Array<{ id: number; embedding: number[] }> = [];

  saveChunks(chunks: Chunk[]): number[] {
    const start = this.chunks.length + 1;
    this.chunks.push(...chunks);
    return chunks.map((_, index) => start + index);
  }

  storeEmbedding(id: number, embedding: number[]): void {
    this.embeddings.push({ id, embedding });
  }
}

class FakeEmbeddingPipeline {
  isReady(): boolean {
    return true;
  }

  async embedDocumentsBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => [text.length, 1, 0]);
  }

  async getEmbedding(text: string): Promise<number[]> {
    return [text.length, 1, 0];
  }
}

test('LiveRAGIndexer can force-flush a single finalized interviewer turn', async () => {
  const vectorStore = new FakeVectorStore();
  const indexer = new LiveRAGIndexer(vectorStore as any, new FakeEmbeddingPipeline() as any);
  (indexer as any).saveChunksViaWorker = async (chunks: Chunk[]) => vectorStore.saveChunks(chunks);

  try {
    indexer.start('live-test');
    indexer.feedSegments([
      {
        speaker: 'interviewer',
        text: 'How would you design live retrieval freshness?',
        timestamp: 1_000,
      },
    ]);

    await indexer.flushNow('final_interviewer_turn');

    assert.equal(vectorStore.chunks.length, 1);
    assert.match(vectorStore.chunks[0].text, /live retrieval freshness/);
    assert.equal(vectorStore.embeddings.length, 1);
  } finally {
    await indexer.stop();
  }
});

test('LiveRAGIndexer stop force-flushes below-threshold transcript tails', async () => {
  const vectorStore = new FakeVectorStore();
  const indexer = new LiveRAGIndexer(vectorStore as any, new FakeEmbeddingPipeline() as any);
  (indexer as any).saveChunksViaWorker = async (chunks: Chunk[]) => vectorStore.saveChunks(chunks);

  try {
    indexer.start('live-stop-test');
    indexer.feedSegments([
      {
        speaker: 'user',
        text: 'I would keep the cache aside strategy.',
        timestamp: 2_000,
      },
    ]);

    await indexer.stop();

    assert.equal(vectorStore.chunks.length, 1);
    assert.match(vectorStore.chunks[0].text, /cache aside strategy/);
    assert.equal(vectorStore.embeddings.length, 1);
  } finally {
    await indexer.stop();
  }
});
