import fs from 'node:fs';

/**
 * OcrService — platform-aware OCR cascade for non-vision LLM paths.
 *
 * Trigger conditions (chosen by LLMHelper, not this service):
 *   - User selected a text-only model (Groq llama-3.x, Cerebras llama, etc.)
 *   - User selected a cURL provider whose template can't accept images
 *   - Multimodal call returned an image-capability error and we need a text
 *     fallback
 *
 * Cascade order:
 *   macOS  → Apple Vision (VNRecognizeTextRequest) → Tesseract.js
 *   Windows → Windows.Media.Ocr (OcrEngine)         → Tesseract.js
 *   Linux  →                                          Tesseract.js
 *
 * Apple Vision and Windows OCR are free, fast (50-100 ms), and ship with
 * the OS. Tesseract is the universal fallback — slower (~3-10s per image)
 * and lower quality on UI screenshots, but works everywhere including
 * machines where the native provider has no installed language packs.
 *
 * The service is a thin orchestrator. Each provider is independent so a
 * native binding regression in one platform doesn't break the others.
 *
 * Reliability invariants:
 *   * `recognize` never throws — failures cascade quietly and a
 *     fully-failed batch returns `{ text: '', provider: 'none' }`.
 *   * Every provider call is wrapped in a per-image timeout so a hung
 *     Tesseract worker can never block the LLM lane indefinitely.
 *   * Caller-supplied `AbortSignal` shortcircuits the cascade between
 *     providers without breaking the in-flight call (the underlying
 *     Vision/WinRT/Tesseract APIs aren't cancellable).
 *   * Availability cache is TTL-bounded so a transient native-module
 *     load failure during cold start doesn't permanently degrade the
 *     cascade for the lifetime of the process.
 */

export interface OcrResult {
  text: string;
  provider: string;
  durationMs: number;
}

export interface OcrProvider {
  /** Stable identifier used in logs and `OcrResult.provider`. */
  readonly name: string;
  /** Quick check whether the provider can run on this build. */
  isAvailable(): Promise<boolean>;
  /** Recognize text from a PNG/JPEG file at `imagePath`. */
  recognize(imagePath: string): Promise<string>;
}

/** Optional per-call overrides. */
export interface OcrRecognizeOptions {
  /** Abort the cascade. Already-running provider calls aren't interrupted
   *  (Vision / WinRT / Tesseract aren't cancellable) but no further
   *  provider is attempted. */
  signal?: AbortSignal;
  /** Per-provider timeout in ms. Defaults to 15 s — enough for Tesseract
   *  on a 2K screenshot, well above Apple Vision (~150 ms) and Windows
   *  OCR (~250 ms). */
  timeoutMs?: number;
}

/** Stable error tags emitted by the Rust native module — see
 *  `native-module/src/ocr.rs` for the matching constants. We treat these
 *  as "skip this provider quietly, expected on this image / platform". */
const QUIET_FAILURE_PATTERNS: readonly string[] = [
  'Unsupported on this platform',
  'Image not found',
  'Image path is empty',
  'Image path is not a regular file',
  'Image path contains invalid UTF-8',
];

/** Cached availability lives this long before re-probing the provider.
 *  Long enough to avoid hot-path overhead, short enough to recover from a
 *  transient native-module load failure during cold start. */
const AVAILABILITY_TTL_MS = 60_000;

/** Default per-image timeout. Tesseract.js on a 2K screenshot averages
 *  3–10 s; native providers finish in well under a second. We pick a
 *  bound that covers both without leaving the LLM lane stuck. */
const DEFAULT_OCR_TIMEOUT_MS = 15_000;

interface AvailabilityEntry {
  available: boolean;
  expiresAt: number;
}

export class OcrService {
  private readonly providers: OcrProvider[];
  private readonly availabilityCache = new Map<string, AvailabilityEntry>();
  private readonly availabilityTtlMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(
    providers: OcrProvider[],
    options: { availabilityTtlMs?: number; defaultTimeoutMs?: number } = {},
  ) {
    this.providers = providers;
    this.availabilityTtlMs = options.availabilityTtlMs ?? AVAILABILITY_TTL_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  }

  /**
   * Run OCR on a single image, walking the cascade until a non-empty
   * result comes back. Returns an empty string only when *every* provider
   * either fails or returns no text. Never throws — failure is signalled
   * with an empty string and a logged warning, since the caller will
   * already have a "best-effort" prompt to fall back to.
   */
  async recognize(imagePath: string, options: OcrRecognizeOptions = {}): Promise<OcrResult> {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { text: '', provider: 'none', durationMs: 0 };
    }
    if (options.signal?.aborted) {
      return { text: '', provider: 'none', durationMs: 0 };
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    for (const provider of this.providers) {
      if (options.signal?.aborted) {
        return { text: '', provider: 'none', durationMs: 0 };
      }

      const available = await this.checkAvailability(provider);
      if (!available) continue;

      const startedAt = Date.now();
      try {
        const text = (await this.runWithTimeout(provider, imagePath, timeoutMs)).trim();
        const durationMs = Date.now() - startedAt;
        if (text.length > 0) {
          return { text, provider: provider.name, durationMs };
        }
        // Empty result — fall through to the next provider rather than
        // returning the empty string immediately. A blank image is rare;
        // most "empty" outcomes mean the provider couldn't read the
        // content (e.g. Vision missing a language pack).
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);

        if (QUIET_FAILURE_PATTERNS.some((p) => reason.includes(p))) {
          // "Unsupported on this platform" is a stable contract from the
          // native module — invalidate the availability cache and move
          // on quietly without spamming logs.
          if (reason.includes('Unsupported on this platform')) {
            this.markUnavailable(provider.name);
          }
          continue;
        }

        if (reason.includes('OCR timed out')) {
          console.warn(
            `[OcrService] ${provider.name} timed out after ${timeoutMs}ms, falling through`,
          );
        } else {
          console.warn(`[OcrService] ${provider.name} failed: ${reason}`);
        }
      }
    }

    return { text: '', provider: 'none', durationMs: 0 };
  }

  /**
   * Recognize multiple images in sequence. Sequential is intentional —
   * Apple Vision and Windows OCR aren't thread-safe in a way that scales
   * usefully past 1-2 concurrent requests, and Tesseract is single-threaded
   * by default. The caller (LLMHelper) typically has at most 5 images
   * queued so latency is fine.
   *
   * The abort signal is re-checked between images so a long batch can be
   * cut short cleanly when the LLM call is cancelled or times out.
   */
  async recognizeMany(imagePaths: string[], options: OcrRecognizeOptions = {}): Promise<OcrResult[]> {
    const results: OcrResult[] = [];
    for (const path of imagePaths) {
      if (options.signal?.aborted) break;
      results.push(await this.recognize(path, options));
    }
    return results;
  }

  /** Reset cached availability — used by tests and after a known
   *  recovery event (native module reloaded, etc.). */
  resetAvailabilityCache(): void {
    this.availabilityCache.clear();
  }

  private async checkAvailability(provider: OcrProvider): Promise<boolean> {
    const now = Date.now();
    const cached = this.availabilityCache.get(provider.name);
    if (cached && cached.expiresAt > now) {
      return cached.available;
    }
    let available = false;
    try {
      available = await provider.isAvailable();
    } catch (err) {
      console.warn(`[OcrService] availability check failed for ${provider.name}:`, err);
      available = false;
    }
    this.availabilityCache.set(provider.name, {
      available,
      // Successful availability stays cached for the full TTL; a failed
      // probe stays cached for half that window so a transient cold-start
      // load failure doesn't degrade the cascade for a full minute.
      expiresAt: now + (available ? this.availabilityTtlMs : Math.floor(this.availabilityTtlMs / 2)),
    });
    return available;
  }

  private markUnavailable(name: string): void {
    this.availabilityCache.set(name, {
      available: false,
      // Re-probe sooner than the regular failure window — "Unsupported
      // on this platform" is fixed across the process lifetime, but
      // future builds may swap providers under us in dev mode.
      expiresAt: Date.now() + this.availabilityTtlMs,
    });
  }

  /**
   * Wrap a provider's recognize() call with a hard timeout. Vision /
   * WinRT / Tesseract aren't cancellable, so the in-flight call may
   * still complete in the background — but the *cascade* moves on so
   * the LLM lane never stalls.
   */
  private runWithTimeout(
    provider: OcrProvider,
    imagePath: string,
    timeoutMs: number,
  ): Promise<string> {
    if (timeoutMs <= 0) {
      return provider.recognize(imagePath);
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const handle = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`OCR timed out after ${timeoutMs}ms (${provider.name})`));
      }, timeoutMs);

      provider
        .recognize(imagePath)
        .then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(handle);
          resolve(value);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(handle);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
