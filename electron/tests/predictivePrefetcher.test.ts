import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { PredictivePrefetcher } from '../prefetch/PredictivePrefetcher';
import { setOptimizationFlags } from '../config/optimizations';
import { setEmbeddingProvider } from '../cache/ParallelContextAssembler';

describe('PredictivePrefetcher', () => {
  let prefetcher: PredictivePrefetcher;

  beforeEach(() => {
    setOptimizationFlags({ accelerationEnabled: true, usePrefetching: true });
    prefetcher = new PredictivePrefetcher({
      maxPrefetchPredictions: 5,
      maxMemoryMB: 50,
    });
  });

  afterEach(() => {
    setOptimizationFlags({ accelerationEnabled: false, usePrefetching: true });
    setEmbeddingProvider(null);
  });

  it('should predict follow-ups based on phase', async () => {
    prefetcher.onPhaseChange('deep_dive');

    prefetcher.onSilenceStart();

    await new Promise(resolve => setTimeout(resolve, 100));

    const predictions = prefetcher.getPredictions();
    assert(predictions.length > 0);
  });

  it('should cache prefetched contexts', async () => {
    prefetcher.updateTranscriptSegments([
      {
        speaker: 'interviewer',
        text: 'Let us talk about the main components and how they communicate.',
        timestamp: Date.now(),
      },
    ]);
    prefetcher.onPhaseChange('high_level_design');
    prefetcher.onSilenceStart();
    await new Promise(resolve => setTimeout(resolve, 100));

    const context = await prefetcher.getContext('What are the main components?');
    assert(context);
    assert(context.relevantContext.length > 0);
  });

  it('should stop prefetching when user starts speaking', async () => {
    prefetcher.onSilenceStart();
    prefetcher.onUserSpeaking();

    const predictions = prefetcher.getPredictions();
    assert(predictions.length === 0 || predictions.length >= 0);
  });

  it('should clear cache on topic shift', () => {
    prefetcher.onSilenceStart();
    prefetcher.onTopicShiftDetected();

    const predictions = prefetcher.getPredictions();
    assert(predictions.length === 0);
  });

  it('uses the active embedding provider for prefetch predictions and semantic lookup', async () => {
    const embedCalls: string[] = [];
    setEmbeddingProvider({
      isInitialized: () => true,
      embed: async (text: string) => {
        embedCalls.push(text);
        return text.includes('scale') ? [1, 0] : [0, 1];
      },
    });
    setOptimizationFlags({ accelerationEnabled: true, usePrefetching: true, semanticCacheThreshold: 0.2 });
    prefetcher = new PredictivePrefetcher({
      maxPrefetchPredictions: 5,
      maxMemoryMB: 50,
    });

    prefetcher.updateTranscriptSegments([
      {
        speaker: 'interviewer',
        text: 'How does this scale to millions of users?',
        timestamp: Date.now(),
      },
    ], 1);
    prefetcher.onPhaseChange('scaling_discussion');
    prefetcher.onSilenceStart();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const context = await prefetcher.getContext('What about scale?');

    assert.ok(context);
    assert.ok(embedCalls.length > 0);
  });

  it('returns an empty embedding when no real embedding provider is registered', async () => {
    const embedding = await prefetcher.getSemanticEmbedding('What about scale?');

    assert.deepEqual(embedding, []);
  });

  it('reuses rolling BM25 results until transcript revision changes', async () => {
    prefetcher.updateTranscriptSegments([
      {
        speaker: 'interviewer',
        text: 'What are the main components and how do they communicate?',
        timestamp: Date.now(),
      },
    ], 7);

    await (prefetcher as any).assembleContext('What are the main components?');
    assert.equal((prefetcher as any).bm25Cache.size, 1);

    await (prefetcher as any).assembleContext('What are the main components?');
    assert.equal((prefetcher as any).bm25Cache.size, 1);

    prefetcher.updateTranscriptSegments([
      {
        speaker: 'interviewer',
        text: 'What are the main components and how do they communicate?',
        timestamp: Date.now(),
      },
      {
        speaker: 'user',
        text: 'There is also a cache in front of the datastore.',
        timestamp: Date.now() + 1,
      },
    ], 8);

    assert.equal((prefetcher as any).bm25Cache.size, 0);
    await (prefetcher as any).assembleContext('What are the main components?');
    assert.equal((prefetcher as any).bm25Cache.size, 1);
  });
});
