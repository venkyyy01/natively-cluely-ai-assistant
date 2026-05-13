/**
 * Embedding pipeline disposable registry.
 *
 * Crash repro (incident FEBA7065-2593-4EC6-88CD-4FB87621EA96 in `crashreport.md`):
 *   Thread 0 SIGTRAPs inside `~InferenceSessionWrap()` (napi-v3 onnxruntime
 *   binding bundled with `@xenova/transformers`, libonnxruntime.1.14.0) during
 *   the V8 finalizer queue drain that runs after `process.exit()` (or any GC
 *   pass that collects an unreferenced pipeline). The destructor walks a
 *   `std::variant<std::string, std::string_view>` member whose backing heap
 *   has already been torn down by Node's shutdown sequence, tripping a
 *   debug-build CHECK.
 *
 * Mitigation: every long-lived consumer of `@xenova/transformers#pipeline` or
 * raw `onnxruntime-node#InferenceSession` registers itself here on
 * construction. `GracefulShutdownManager` drains the registry **before**
 * `process.exit()`, so the C++ destructors run while the runtime is still
 * healthy.
 *
 * The registry is intentionally minimal:
 *   - identity-keyed (`Set`), so registering the same disposable twice is a
 *     no-op;
 *   - dispose errors are logged and swallowed (the napi finalizer path that
 *     would otherwise SIGTRAP is exactly what we are replacing);
 *   - `disposeAll` clears the registry before awaiting, so a hook that
 *     triggers re-registration (e.g. lazy-init during teardown) cannot loop.
 */

export interface EmbeddingPipelineDisposable {
  dispose(): Promise<void>;
}

const registry: Set<EmbeddingPipelineDisposable> = new Set();

/**
 * Register a disposable embedding pipeline. Returns an `unregister` function
 * that the disposable should call from its own `dispose()` once it has
 * finished releasing its native session, so the registry does not keep a
 * dead reference alive for the rest of the process lifetime.
 */
export function registerEmbeddingPipeline(
  disposable: EmbeddingPipelineDisposable,
): () => void {
  registry.add(disposable);
  return () => {
    registry.delete(disposable);
  };
}

/**
 * Dispose every registered embedding pipeline. Safe to call multiple times;
 * each call drains the current set and clears it before awaiting, so
 * disposables that re-register concurrently are picked up on the next call
 * rather than being missed.
 *
 * Errors thrown by individual `dispose()` implementations are logged and
 * swallowed — the entire point of this helper is to prevent the napi
 * finalizer path from crashing the process, so we must never re-throw and
 * skip the remaining disposables.
 */
export async function disposeAllEmbeddingPipelines(): Promise<void> {
  if (registry.size === 0) {
    return;
  }
  const items = Array.from(registry);
  registry.clear();
  await Promise.allSettled(
    items.map(async (item) => {
      try {
        await item.dispose();
      } catch (err) {
        console.warn(
          '[EmbeddingPipelineRegistry] dispose error swallowed:',
          err,
        );
      }
    }),
  );
}

/**
 * Test-only inspector. Production code must not depend on this.
 */
export function _getRegistrySizeForTest(): number {
  return registry.size;
}
