import type { OcrProvider } from '../OcrService';

/**
 * Tesseract.js OCR provider — pure-JS WASM-backed Tesseract.
 *
 * Universal fallback. Slow (3-10s per image) and noisy on UI screenshots
 * but works everywhere including Linux and any machine without an
 * installed native OCR language pack. Defaults to English — same setting
 * the previous standalone Tesseract path used.
 */
export class TesseractOcrProvider implements OcrProvider {
  public readonly name = 'tesseract';
  private readonly lang: string;

  constructor(lang: string = 'eng') {
    this.lang = lang;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tesseract = require('tesseract.js');
      return typeof tesseract?.recognize === 'function';
    } catch {
      return false;
    }
  }

  async recognize(imagePath: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Tesseract = require('tesseract.js');
    const result = await Tesseract.recognize(imagePath, this.lang);
    return (result?.data?.text ?? '').toString();
  }
}
