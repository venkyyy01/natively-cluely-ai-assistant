/**
 * Regression coverage for the crash documented in `crashreport.md` (incident
 * FEBA7065-2593-4EC6-88CD-4FB87621EA96).
 *
 * Thread 0 SIGTRAPs inside `~InferenceSessionWrap()` (napi-v3 onnxruntime
 * binding bundled with `@xenova/transformers`) when V8 drains the finalizer
 * queue after `process.exit()`. The mitigation is to release every long-lived
 * ONNX pipeline via the registry exposed by
 * `electron/conscious/embeddingPipelineRegistry`.
 *
 * These tests exercise the contract that the four conscious classifiers rely
 * on:
 *   1. `registerEmbeddingPipeline` returns an `unregister` that removes the
 *      entry from the live set.
 *   2. `disposeAllEmbeddingPipelines` invokes every registered disposable's
 *      `dispose()`, swallows individual failures, and is safe to call twice.
 *   3. A classifier (`SemanticThreadMatcher` here, chosen because its
 *      lazy-load path is trivially observable) registers itself on
 *      construction, exposes an idempotent `dispose()`, and falls out of the
 *      registry afterwards.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerEmbeddingPipeline,
  disposeAllEmbeddingPipelines,
  _getRegistrySizeForTest,
} from '../conscious/embeddingPipelineRegistry';
import { SemanticThreadMatcher } from '../conscious/SemanticThreadMatcher';

describe('embeddingPipelineRegistry', () => {
  beforeEach(async () => {
    // Drain the registry between tests so we observe only the disposables
    // each test registers itself.
    await disposeAllEmbeddingPipelines();
  });

  it('registers a disposable and returns a working unregister handle', () => {
    const before = _getRegistrySizeForTest();
    const unregister = registerEmbeddingPipeline({ dispose: async () => {} });
    assert.equal(_getRegistrySizeForTest(), before + 1);
    unregister();
    assert.equal(_getRegistrySizeForTest(), before);
  });

  it('disposeAll invokes every registered disposable and clears the set', async () => {
    let disposedA = false;
    let disposedB = false;
    registerEmbeddingPipeline({
      dispose: async () => {
        disposedA = true;
      },
    });
    registerEmbeddingPipeline({
      dispose: async () => {
        disposedB = true;
      },
    });
    assert.equal(_getRegistrySizeForTest(), 2);
    await disposeAllEmbeddingPipelines();
    assert.equal(disposedA, true);
    assert.equal(disposedB, true);
    assert.equal(_getRegistrySizeForTest(), 0);
  });

  it('disposeAll swallows individual dispose() errors so the rest still run', async () => {
    let downstreamRan = false;
    registerEmbeddingPipeline({
      dispose: async () => {
        throw new Error('synthetic teardown failure');
      },
    });
    registerEmbeddingPipeline({
      dispose: async () => {
        downstreamRan = true;
      },
    });
    await disposeAllEmbeddingPipelines();
    assert.equal(
      downstreamRan,
      true,
      'a thrown dispose() must not prevent later disposables from running',
    );
    assert.equal(_getRegistrySizeForTest(), 0);
  });

  it('disposeAll is safe to call twice without error', async () => {
    registerEmbeddingPipeline({ dispose: async () => {} });
    await disposeAllEmbeddingPipelines();
    await disposeAllEmbeddingPipelines();
    assert.equal(_getRegistrySizeForTest(), 0);
  });
});

describe('SemanticThreadMatcher disposable contract', () => {
  beforeEach(async () => {
    await disposeAllEmbeddingPipelines();
  });

  it('registers itself in the registry on construction', () => {
    const before = _getRegistrySizeForTest();
    const matcher = new SemanticThreadMatcher();
    assert.equal(_getRegistrySizeForTest(), before + 1);
    // Touch the binding so TS does not flag the value as unused.
    assert.equal(typeof matcher.dispose, 'function');
  });

  it('dispose() removes the matcher from the registry', async () => {
    const matcher = new SemanticThreadMatcher();
    const sizeWithMatcher = _getRegistrySizeForTest();
    await matcher.dispose();
    assert.equal(_getRegistrySizeForTest(), sizeWithMatcher - 1);
  });

  it('dispose() is idempotent', async () => {
    const matcher = new SemanticThreadMatcher();
    await matcher.dispose();
    const sizeAfterFirst = _getRegistrySizeForTest();
    await matcher.dispose();
    assert.equal(_getRegistrySizeForTest(), sizeAfterFirst);
  });

  it('disposeAllEmbeddingPipelines() disposes a live matcher', async () => {
    // Two matchers, neither manually disposed — both should be flushed by
    // the shutdown hook in `AppState.registerShutdownHooks()`.
    const a = new SemanticThreadMatcher();
    const b = new SemanticThreadMatcher();
    assert.equal(typeof a.dispose, 'function');
    assert.equal(typeof b.dispose, 'function');
    await disposeAllEmbeddingPipelines();
    assert.equal(_getRegistrySizeForTest(), 0);
  });
});
