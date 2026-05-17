import type { OcrProvider } from '../OcrService';

/**
 * Tesseract.js OCR provider — pure-JS WASM-backed Tesseract.
 *
 * Universal fallback. Slow (3-10s per image) and noisy on UI screenshots
 * but works everywhere including Linux and any machine without an
 * installed native OCR language pack. Defaults to English — same setting
 * the previous standalone Tesseract path used.
 *
 * The Tesseract.js module is loaded lazily and memoised: it pulls in a
 * non-trivial WASM bundle (~10 MB) and a worker pool, so we don't want
 * to pay that on cold start unless the cascade actually needs it.
 */

type TesseractRecognize = (
  imagePath: string,
  lang: string,
) => Promise<{ data?: { text?: string } } | null>;

interface TesseractModule {
  recognize?: TesseractRecognize;
}

let cachedTesseract: TesseractModule | null | undefined;

function loadTesseract(): TesseractModule | null {
  if (cachedTesseract !== undefined) return cachedTesseract;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedTesseract = require('tesseract.js') as TesseractModule;
  } catch {
    cachedTesseract = null;
  }
  return cachedTesseract;
}

export class TesseractOcrProvider implements OcrProvider {
  public readonly name = 'tesseract';
  private readonly lang: string;

  constructor(lang: string = 'eng') {
    this.lang = lang;
  }

  async isAvailable(): Promise<boolean> {
    const mod = loadTesseract();
    return typeof mod?.recognize === 'function';
  }

  async recognize(imagePath: string): Promise<string> {
    const mod = loadTesseract();
    const fn = mod?.recognize;
    if (typeof fn !== 'function') {
      throw new Error('tesseract.js module not available');
    }
    const result = await fn(imagePath, this.lang);
    return ((result?.data?.text ?? '') as string).toString();
  }
}
