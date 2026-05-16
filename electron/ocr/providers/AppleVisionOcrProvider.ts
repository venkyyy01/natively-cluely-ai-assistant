import type { OcrProvider } from '../OcrService';

/**
 * Apple Vision OCR provider — calls into the Rust napi binding
 * `recognizeTextMacos` which wraps VNRecognizeTextRequest.
 *
 * - Available only on macOS 10.15+ (the Vision recognize-text API).
 * - Free; ships with the OS; no network calls; no permissions required.
 * - Typical latency: 50-150 ms per image at "Accurate" recognition level.
 */
export class AppleVisionOcrProvider implements OcrProvider {
  public readonly name = 'apple-vision';

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const native = require('natively-audio') as { recognizeTextMacos?: (path: string) => string };
      return typeof native?.recognizeTextMacos === 'function';
    } catch {
      return false;
    }
  }

  async recognize(imagePath: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require('natively-audio') as { recognizeTextMacos: (path: string) => string };
    return native.recognizeTextMacos(imagePath);
  }
}
