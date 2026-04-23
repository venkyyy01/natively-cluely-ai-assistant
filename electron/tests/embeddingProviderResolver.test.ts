import test from 'node:test';
import assert from 'node:assert/strict';

import { EmbeddingProviderResolver } from '../rag/EmbeddingProviderResolver';
import { ANEEmbeddingProvider } from '../rag/providers/ANEEmbeddingProvider';
import { DEFAULT_OPTIMIZATION_FLAGS, setOptimizationFlagsForTesting } from '../config/optimizations';

test('EmbeddingProviderResolver initializes the ANE provider before deciding availability', async () => {
  setOptimizationFlagsForTesting({
    ...DEFAULT_OPTIMIZATION_FLAGS,
    accelerationEnabled: true,
    useANEEmbeddings: true,
  });

  const originalProvider = (EmbeddingProviderResolver as any).aneProvider;
  const originalChecked = (EmbeddingProviderResolver as any).aneProviderChecked;
  const originalAvailable = (EmbeddingProviderResolver as any).aneProviderAvailable;
  const originalInitialize = ANEEmbeddingProvider.prototype.initialize;
  const originalIsAvailable = ANEEmbeddingProvider.prototype.isAvailable;
  const initializeCalls: string[] = [];

  (EmbeddingProviderResolver as any).aneProvider = null;
  (EmbeddingProviderResolver as any).aneProviderChecked = false;
  (EmbeddingProviderResolver as any).aneProviderAvailable = null;
  ANEEmbeddingProvider.prototype.initialize = async function mockInitialize() {
    initializeCalls.push('initialize');
    (this as any).initialized = true;
  };
  ANEEmbeddingProvider.prototype.isAvailable = async function mockIsAvailable() {
    return (this as any).initialized;
  };

  try {
    const provider = await EmbeddingProviderResolver.resolve({});
    const providerAgain = await EmbeddingProviderResolver.resolve({});
    assert.equal(provider.name, 'ane-embedding');
    assert.equal(providerAgain, provider);
    assert.equal((provider as any).initialized, true);
    assert.deepEqual(initializeCalls, ['initialize']);
  } finally {
    ANEEmbeddingProvider.prototype.initialize = originalInitialize;
    ANEEmbeddingProvider.prototype.isAvailable = originalIsAvailable;
    (EmbeddingProviderResolver as any).aneProvider = originalProvider;
    (EmbeddingProviderResolver as any).aneProviderChecked = originalChecked;
    (EmbeddingProviderResolver as any).aneProviderAvailable = originalAvailable;
    setOptimizationFlagsForTesting({ ...DEFAULT_OPTIMIZATION_FLAGS });
  }
});
