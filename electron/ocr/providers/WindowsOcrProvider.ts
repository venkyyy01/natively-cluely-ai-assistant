import type { OcrProvider } from '../OcrService';

/**
 * Windows OCR provider — calls into the Rust napi binding
 * `recognizeTextWindows` which wraps `Windows.Media.Ocr.OcrEngine`.
 *
 * - Available on Windows 10/11.
 * - Requires at least one OCR language pack to be installed. Picks the
 *   user profile language first, then en-US, then any available.
 * - Free; ships with the OS; no network calls; no permissions required.
 * - Typical latency: 80-200 ms per image.
 *
 * As with the macOS provider, the native binding is loaded lazily and
 * memoised so a missing/broken `natively-audio` package degrades to
 * Tesseract instead of throwing on every screenshot.
 */

type RecognizeFn = (path: string) => string;

interface NativeBinding {
  recognizeTextWindows?: RecognizeFn;
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

export class WindowsOcrProvider implements OcrProvider {
  public readonly name = 'windows-ocr';

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    const native = loadNative();
    return typeof native?.recognizeTextWindows === 'function';
  }

  async recognize(imagePath: string): Promise<string> {
    const native = loadNative();
    const fn = native?.recognizeTextWindows;
    if (typeof fn !== 'function') {
      throw new Error('Unsupported on this platform');
    }
    try {
      return fn(imagePath);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
