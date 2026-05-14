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
 * Once shutdown has begun, any newly-constructed disposable must dispose
 * itself rather than join the registry — there is no guarantee anyone will
 * drain it before `process.exit()` triggers V8 finalizers (R3).
 */
let shuttingDown = false;

/**
 * Per-disposable timeout. If a single `Pipeline.dispose()` hangs (e.g. the
 * underlying `pipeline()` promise never resolved), we must not let it starve
 * the rest of the registry. After this many milliseconds we abandon the
 * individual dispose and move on; the process will exit moments later and
 * the leaked session is the price of forward progress (R4/R5).
 */
const PER_DISPOSE_TIMEOUT_MS = 1500;

/**
 * Register a disposable embedding pipeline. Returns an `unregister` function
 * that the disposable should call from its own `dispose()` once it has
 * finished releasing its native session, so the registry does not keep a
 * dead reference alive for the rest of the process lifetime.
 *
 * If shutdown has already begun, the disposable is **not** added to the
 * registry. Instead its `dispose()` is invoked immediately on a detached
 * promise so the native session is released as soon as possible. Returns a
 * no-op unregister so the caller's `dispose()` does not throw.
 */
export function registerEmbeddingPipeline(
  disposable: EmbeddingPipelineDisposable,
): () => void {
  if (shuttingDown) {
    // Detached: callers do not (and must not) await this; the registry
    // contract is fire-and-forget at shutdown.
    void disposable.dispose().catch((err) => {
      console.warn(
        '[EmbeddingPipelineRegistry] late-registration dispose error swallowed:',
        err,
      );
    });
    return () => {};
  }
  registry.add(disposable);
  return () => {
    registry.delete(disposable);
  };
}

async function disposeOneWithTimeout(
  item: EmbeddingPipelineDisposable,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`dispose timed out after ${PER_DISPOSE_TIMEOUT_MS}ms`)),
      PER_DISPOSE_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([item.dispose(), timeout]);
  } catch (err) {
    console.warn(
      '[EmbeddingPipelineRegistry] dispose error swallowed:',
      err,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
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
 *
 * Sets the `shuttingDown` flag on first entry so that any classifier
 * constructed after this point (e.g. from a stale audio callback) disposes
 * itself immediately rather than leaking past the registry.
 */
export async function disposeAllEmbeddingPipelines(): Promise<void> {
  shuttingDown = true;
  if (registry.size === 0) {
    return;
  }
  const items = Array.from(registry);
  registry.clear();
  await Promise.allSettled(items.map(disposeOneWithTimeout));
}

/**
 * Test-only inspector. Production code must not depend on this.
 */
export function _getRegistrySizeForTest(): number {
  return registry.size;
}

/**
 * Test-only reset. Production code must not depend on this. Resets the
 * `shuttingDown` flag so a subsequent test can register disposables without
 * triggering the late-registration fast-dispose path.
 */
export function _resetRegistryForTest(): void {
  registry.clear();
  shuttingDown = false;
}
