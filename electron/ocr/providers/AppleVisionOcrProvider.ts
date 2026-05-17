import type { OcrProvider } from '../OcrService';

/**
 * Apple Vision OCR provider — calls into the Rust napi binding
 * `recognizeTextMacos` which wraps VNRecognizeTextRequest.
 *
 * - Available only on macOS 10.15+ (the Vision recognize-text API).
 * - Free; ships with the OS; no network calls; no permissions required.
 * - Typical latency: 50-150 ms per image at "Accurate" recognition level.
 *
 * The native binding is loaded lazily and memoised so the cascade can
 * survive a missing/broken `natively-audio` package without throwing on
 * every screenshot. A `null` cache entry means "we tried, it didn't
 * load, don't try again this process". We re-evaluate only via
 * `OcrService`'s availability TTL.
 */

type RecognizeFn = (path: string) => string;

interface NativeBinding {
  recognizeTextMacos?: RecognizeFn;
}

let cachedNative: NativeBinding | null | undefined;

function loadNative(): NativeBinding | null {
  if (cachedNative !== undefined) return cachedNative;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedNative = require('natively-audio') as NativeBinding;
  } catch {
    cachedNative = null;
  }
  return cachedNative;
}

export class AppleVisionOcrProvider implements OcrProvider {
  public readonly name = 'apple-vision';

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    const native = loadNative();
    return typeof native?.recognizeTextMacos === 'function';
  }

  async recognize(imagePath: string): Promise<string> {
    const native = loadNative();
    const fn = native?.recognizeTextMacos;
    if (typeof fn !== 'function') {
      throw new Error('Unsupported on this platform');
    }
    // The Rust call is synchronous — wrap so any synchronous throw
    // surfaces as a rejected promise and gets handled by the cascade
    // rather than aborting the await chain mid-image.
    try {
      return fn(imagePath);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
