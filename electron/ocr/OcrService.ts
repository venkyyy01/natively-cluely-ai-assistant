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

export class OcrService {
  private readonly providers: OcrProvider[];
  private availabilityCache = new Map<string, boolean>();

  constructor(providers: OcrProvider[]) {
    this.providers = providers;
  }

  /**
   * Run OCR on a single image, walking the cascade until a non-empty
   * result comes back. Returns an empty string only when *every* provider
   * either fails or returns no text. Never throws — failure is signalled
   * with an empty string and a logged warning, since the caller will
   * already have a "best-effort" prompt to fall back to.
   */
  async recognize(imagePath: string): Promise<OcrResult> {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return { text: '', provider: 'none', durationMs: 0 };
    }

    for (const provider of this.providers) {
      const available = await this.checkAvailability(provider);
      if (!available) continue;

      const startedAt = Date.now();
      try {
        const text = (await provider.recognize(imagePath)).trim();
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
        // "Unsupported on this platform" is a stable contract from the
        // native module — log at debug level only.
        if (reason.includes('Unsupported on this platform')) {
          this.availabilityCache.set(provider.name, false);
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
   */
  async recognizeMany(imagePaths: string[]): Promise<OcrResult[]> {
    const results: OcrResult[] = [];
    for (const path of imagePaths) {
      results.push(await this.recognize(path));
    }
    return results;
  }

  private async checkAvailability(provider: OcrProvider): Promise<boolean> {
    const cached = this.availabilityCache.get(provider.name);
    if (cached !== undefined) return cached;
    let available = false;
    try {
      available = await provider.isAvailable();
    } catch (err) {
      console.warn(`[OcrService] availability check failed for ${provider.name}:`, err);
      available = false;
    }
    this.availabilityCache.set(provider.name, available);
    return available;
  }
}
