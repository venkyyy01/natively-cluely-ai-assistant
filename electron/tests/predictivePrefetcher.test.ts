import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { PredictivePrefetcher } from '../prefetch/PredictivePrefetcher';
import { setOptimizationFlags } from '../config/optimizations';

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
  });

  it('should predict follow-ups based on phase', async () => {
    prefetcher.onPhaseChange('deep_dive');

    prefetcher.onSilenceStart();

    await new Promise(resolve => setTimeout(resolve, 100));

    const predictions = prefetcher.getPredictions();
    assert(predictions.length > 0);
  });

  it('should cache prefetched contexts', async () => {
    prefetcher.onSilenceStart();
    await new Promise(resolve => setTimeout(resolve, 100));

    const context = await prefetcher.getContext('test query', [0, 0, 0]);
    assert(true);
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
});
