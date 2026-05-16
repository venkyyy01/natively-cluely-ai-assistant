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
 */
export class WindowsOcrProvider implements OcrProvider {
  public readonly name = 'windows-ocr';

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const native = require('natively-audio') as { recognizeTextWindows?: (path: string) => string };
      return typeof native?.recognizeTextWindows === 'function';
    } catch {
      return false;
    }
  }

  async recognize(imagePath: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require('natively-audio') as { recognizeTextWindows: (path: string) => string };
    return native.recognizeTextWindows(imagePath);
  }
}
